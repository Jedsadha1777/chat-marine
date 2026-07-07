# RuleFlow Full Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every RuleFlow layer both reachable from domain config and verified by tests, and remove the server 500-risk in budgetPlan evaluation.

**Architecture:** RuleFlow (app/engine/ruleflow/) already implements formula + if-block evaluation, but (a) schema.json only exposes FormulaBlock so IfBlock is unreachable from config, (b) no test covers any RuleFlow layer, (c) `computeAnchorTarget` in backtrack.ts evaluates budgetPlan without error handling — a malformed plan 500s /api/suggest. Fix: characterization test suite for all layers → try/catch fallback (TDD) → expose IfBlock in schema → align DynMax descriptions with real consumers → docs.

**Tech Stack:** TypeScript (Nuxt 4 / CF Pages), tsx test scripts (existing harness style), ajv-cli for schema validation.

**Context notes:** Not a git repository — commit steps omitted. Engine picks quantity=1 per type by spec (test/greedy.ts "not inflated"); dynamicMaxPerType quantity semantics are UI-only by design — schema must say so, not resurrect server code.

---

### Task 1: RuleFlow characterization test suite

**Files:**
- Create: `test/ruleflow.ts`

- [x] **Step 1: Write the suite** (same assert-harness style as test/greedy.ts) covering:
  - tokenizer/parser: precedence (`2+3*4`, `2**3**2` right-assoc, `-2**2` = -4), parens, AND/OR flattening, NOT, strings + escapes, errors (bare ident, unterminated string, unexpected char, trailing tokens)
  - evalExpr: all 9 built-ins (round ceil floor min max abs clamp pow sqrt), div/mod-by-zero RunError, unknown func, undefined var, cmp (num, str, mixed), logic, unary
  - prepareModule: dependency reordering, S4_CYCLE, S6_UNKNOWN_OUTPUT
  - evalModule: input validation (R1_MISSING_REQUIRED, nullable, R1_OUT_OF_RANGE, R1_TYPE_MISMATCH, num coercion), formula chain, if-block (fallback-first, first-match-wins, else, expr-string payload, nested-blocks payload), R2_OUTPUT_MISSING, RunError loc.block
- [x] **Step 2: Run `npx tsx test/ruleflow.ts`** — expect all pass (characterization of existing code; any failure = investigate before proceeding)

### Task 2: computeAnchorTarget fallback (TDD)

**Files:**
- Modify: `app/engine/strategies/backtrack.ts` (computeAnchorTarget)
- Test: `test/ruleflow.ts` (integration section)

- [x] **Step 1: Add failing tests** — buildSuggestion with DOMAIN clone whose budgetPlan is (a) unparseable expr, (b) NaN-producing expr; assert no throw + gpu slot still filled
- [x] **Step 2: Run — expect FAIL (throws)**
- [x] **Step 3: Implement:**

```ts
function defaultAnchorTarget(effectiveBudget: number, entityCount: number): number {
  return Math.round(effectiveBudget * Math.ceil(entityCount / 2) / entityCount)
}

function computeAnchorTarget(effectiveBudget: number, entityCount: number, plan: Module | undefined): number {
  if (!plan) return defaultAnchorTarget(effectiveBudget, entityCount)
  try {
    let prepared = _planCache.get(plan)
    if (!prepared) { prepared = prepareModule(plan); _planCache.set(plan, prepared) }
    const target = Number(evalModule(prepared, { effectiveBudget, entityCount })['anchorTarget'])
    if (!Number.isFinite(target)) throw new RunError('R2_BAD_TARGET', `anchorTarget not finite: ${target}`)
    return target
  } catch (e) {
    console.error('[backtrack] budgetPlan failed — using default anchor target:', e instanceof Error ? e.message : e)
    return defaultAnchorTarget(effectiveBudget, entityCount)
  }
}
```

- [x] **Step 4: Run — expect PASS**

### Task 3: Expose IfBlock in schema.json

**Files:**
- Modify: `app/domains/schema.json`

- [x] **Step 1: Add $defs** — `Block` (oneOf Formula/If), `IfBlock` (id/outs/branches/else + execution-order description), `OutDecl` ([name, type, fallback] tuple), `IfBranch` ([condExpr, payload] tuple), `Payload` (SetMap object | nested Block[]); point `Module.blocks.items` at `Block`; drop the "formula blocks only" note
- [x] **Step 2: Validate** — `ajv validate --spec=draft2020`: pc-builder.json passes; a sample tiered if-block module passes; a malformed if-block (missing else) fails

### Task 4: DynMax consumer accuracy in schema

**Files:**
- Modify: `app/domains/schema.json` (dynamicMaxPerType, DynamicMaxCfg descriptions)

- [x] **Step 1:** State the real consumers: quantity cap (sources/formula/fallback) is enforced by the UI pin limits; the suggestion engine always fills quantity 1 and uses sort_attribute / capacity_attribute only to rank candidates

### Task 5: docs/adding-a-domain.md budgetPlan section

**Files:**
- Modify: `docs/adding-a-domain.md`

- [x] **Step 1:** Add if-block variant example to the budgetPlan section (tiered anchor ratio), matching the schema example

### Task 6: Full verification

- [x] `npx tsx test/ruleflow.ts` — all pass
- [x] `npx tsx test/greedy.ts` — 14/14
- [x] `npx tsx test/suggest-pool.ts` — 104/104
- [x] `npm run build` — success
- [x] `npx nuxt typecheck` — no NEW errors (32 pre-existing UI-layer errors remain out of scope)
- [x] ajv: pc-builder.json + if-block sample validate
