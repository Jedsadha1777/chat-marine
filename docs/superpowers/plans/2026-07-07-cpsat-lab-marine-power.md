# CP-SAT Lab: Marine Power Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local-only solver lab (`solver/` — never deployed to CF) that proves exact MILP solving on a new marine electrical domain the greedy engine structurally cannot serve (quantity sizing + multi-dimensional capacity + real objective).

**Architecture:** `solver/` at repo root with one-way imports (solver → app/engine, never the reverse, so Nitro never bundles it). Marine domain authored against the production `schema.json` (dogfoods the AI-template workflow). Model compiler turns DomainConfig + entities + budget + objective into CPLEX-LP text; `highs` (HiGHS WASM) solves it in Node; strategy layer maps the solution back to `slots` and the EXISTING `validateItems` proves correctness (zero error issues).

**Tech Stack:** TypeScript via tsx (existing test harness style), `highs` npm (devDependency), ajv-cli for schema validation.

**Scope guard:** No changes to `app/`, `server/`, `schema.json`, or existing domains. Objective is a lab-only extension field (`x_objective`) — schema-level objective design happens at graduation, not now.

---

### Task 1: Marine domain authored against production schema

**Files:**
- Create: `solver/domains/marine-power.json` (DomainConfig-compliant + `x_objective`)
- Create: `solver/domains/marine-power.entities.json` (~44 fabricated entities)

Domain: boat off-grid electrics. 4 types — `battery` (qty 1-8), `solar_panel` (qty 1-6), `charge_controller` (qty 1), `inverter` (qty 1). Reference load profile baked into rules: 120Ah/day @12V, peak 1500W, 2-day autonomy.

Rules (all expressible in the EXISTING rule format):
1. `AGG_USABLE_CAPACITY` — sum(usable_ah × qty) from [battery] >= 240 (fixed)
2. `AGG_SOLAR_YIELD` — sum(daily_ah_yield × qty) from [solar_panel] >= 132 (fixed)
3. `AGG_CONTROLLER_CAPACITY` — sum(watt_rating × qty) from [solar_panel] <= charge_controller.max_input_w (entity_attribute — same pattern as the PSU rule)
4. `AGG_INVERTER_PEAK` — min(continuous_w) from [inverter] >= 1500 (fixed)
5. `AGG_DECK_AREA` — sum(area_m2 × qty) from [solar_panel] <= 4.0 (fixed)
6. `AGG_TOTAL_WEIGHT` — sum(weight_kg × qty) from [battery, solar_panel] <= 160 (fixed)
7. `CHEM_MATCH` (pairwise) — charge_controller.supports_chemistry (array) == battery.chemistry (JSON-Logic array containment)
8. `VOLT_MATCH` (pairwise) — inverter.input_voltage == battery.voltage

Data is tuned so constraints interact: cheapest usable-Ah path (AGM) violates weight → solver must switch to LiFePO4, which couples to controller chemistry support. Min-cost solution ≈ 54-55k THB → budget 60k feasible, 45k infeasible.

- [x] **Step 1:** Write both JSON files
- [x] **Step 2:** `npx ajv-cli validate --spec=draft2020 -s app/domains/schema.json -d solver/domains/marine-power.json` → valid

### Task 2: Install solver + API spike (throwaway)

- [x] **Step 1:** `npm i -D highs`
- [x] **Step 2:** Scratchpad-only spike: load highs in Node, solve a 3-variable toy LP, print result shape (`Status`, `Columns[name].Primal`, `ObjectiveValue`). Spike is deleted knowledge-gathering per TDD exploration rule; no production code from it.

### Task 3: RED — write test/cpsat.ts first

**Files:**
- Create: `test/cpsat.ts` (existing assert-harness style)

Scenarios (import solver modules that do not exist yet → run MUST fail):
1. domain loads: 4 types, 8 rules
2. compile smoke: LP text contains `req_battery` (one-hot row) and `budget` row
3. solve @60,000: status `optimal`; **`validateItems(toSimItems(slots), marineCfg)` yields zero error-severity issues** (production validator as oracle)
4. totalCost <= 60,000
5. quantities: battery 1..8; solar_panel 1..6; inverter = controller = exactly 1
6. chemistry + voltage pairwise hold on the chosen set (direct re-check)
7. area <= 4.0 and weight <= 160 recomputed from the result
8. @45,000: status `infeasible` (proof greedy can never give)
9. min-cost stability: totalCost@60k === totalCost@100k (< 60k)
10. objective swap: `max_attribute usable_ah` @100k → usable_ah strictly >= min-cost solution's, totalCost <= 100k

- [x] **Step 1:** Write the file
- [x] **Step 2:** `npx tsx test/cpsat.ts` → FAIL (module not found) — verify RED

### Task 4: GREEN — implement the solver lab

**Files:**
- Create: `solver/model-compiler.ts` — pure: `(cfg, entities, budget, objective) → { lp: string, varMap }`
  - vars: per candidate `y_<id>` binary (picked); qty types add `q_<id>` integer 0..max with `q - max·y <= 0`, `q - y >= 0`
  - one-hot per type: `Σ y = 1` (requiredTypes) / `<= 1`
  - aggregate error rules → linear rows (sum; min/max on single-select types via `Σ(attr−K)·y >= 0` trick; anything else throws `UNSUPPORTED`)
  - pairwise error rules → reuse **`runPairwise` from `~/engine/pairwise`** on each cross pair → `y_a + y_b <= 1`
  - budget row + objective (`min_cost` | `max_attribute`)
- Create: `solver/adapters/highs.ts` — lazy-load highs, `solveLp(lp)`
- Create: `solver/cpsat-strategy.ts` — `cpsatFill(...): Promise<{status, slots, totalCost, objectiveValue}>`; map `Primal > 0.5` picks back to `SlotItem[]`

- [x] **Step 1:** Implement compiler → adapter → strategy (minimal to pass)
- [x] **Step 2:** `npx tsx test/cpsat.ts` → all pass — verify GREEN

### Task 5: Prove production untouched + full verification

- [x] `npx tsx test/ruleflow.ts` && `test/greedy.ts` && `test/suggest-pool.ts` — all green as before
- [x] `npm run build` → success; `grep -ri "highs" dist/_worker.js/` → no matches (solver not in CF bundle)
- [x] Note in solver/README.md: purpose, run command, one-way import rule, graduation checklist (workerd PoC / async FillStrategy / registry wire-in)
