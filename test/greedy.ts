/**
 * Spec-chain engine tests — generic backtracking fill
 *
 * Engine behavior:
 *   GPU: iterate highest→lowest cost; for each, run backtrackFill for remaining types
 *   selectionOrder (RAM→CPU→MB→PSU): each type tried highest-cost first
 *   Tier rules are SOFT PREFERENCES: tier-satisfying candidates sorted before others
 *   PSU: cheapest adequate for total power draw (÷ psuSafetyFactor)
 */

import { ENTITIES, ENTITY_TYPES, ENTITY_TYPE_LABELS } from '~/data/entities'
import type { Entity } from '~/data/types'
import { RULES } from '~/data/rules'
import { buildSuggestion, totalCostOf, type DomainConfig } from '~/engine/suggest'
import { DEFAULT_DOMAIN_CONFIG } from '~/composables/domainConfig'
import {
  FILL_ORDER, MAX_PER_TYPE, DYNAMIC_MAX_PER_TYPE,
  AGGREGATE_GUARD_TYPES, AGGREGATE_DISPLAY, REQUIRED_TYPES,
  COST_ATTRIBUTE, COST_PRECISION, CAPACITY_FACTOR, SELECTION_ORDER,
} from '~/composables/simulationConfig'
import { TIER_RULES } from '~/composables/tierRules'

// ── test harness ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    console.log(`✅ ${label}`)
    passed++
  } else {
    console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

function totalCost(slots: Record<string, { entity: { attributes: Record<string, unknown> }; quantity: number }[]>): number {
  return Object.values(slots).flatMap((s) => s)
    .reduce((sum, s) => sum + Number(s.entity.attributes['unit_cost'] ?? 0) * s.quantity, 0)
}

function slotSummary(slots: Record<string, { entity: { name?: string }; quantity: number }[]>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(slots).filter(([, v]) => v.length > 0).map(([k, v]) => [k, v.length])),
  )
}

// ── standard DomainConfig (mirrors DEFAULT but explicit) ─────────────────────

const CFG: DomainConfig = {
  fillOrder:         [...FILL_ORDER],
  entityTypes:       [...ENTITY_TYPES],
  entityTypeLabels:  { ...ENTITY_TYPE_LABELS },
  maxPerType:        { ...MAX_PER_TYPE },
  dynamicMaxPerType: { ...DYNAMIC_MAX_PER_TYPE },
  aggregateGuardTypes: [...AGGREGATE_GUARD_TYPES],
  aggregateDisplay:  { ...AGGREGATE_DISPLAY },
  requiredTypes:     [...REQUIRED_TYPES],
  costAttribute:     COST_ATTRIBUTE,
  costPrecision:     COST_PRECISION,
  tierRules:         [...TIER_RULES],
  anchorType:        'gpu',
  capacityType:      'psu',
  capacityAttribute: 'watt_output',
  loadAttributes:    ['power_draw_w', 'tdp_w'],
  capacityFactor:    CAPACITY_FACTOR,
  selectionOrder:    [...SELECTION_ORDER],
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — standard budget scenarios with DEFAULT_DOMAIN_CONFIG
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── Standard budget scenarios ──')

// budget 40k → GPU present (RTX4070 fits; RTX4090 alone > 40k)
const g40 = buildSuggestion(ENTITIES, RULES, DEFAULT_DOMAIN_CONFIG, { budget: 40_000 })
const g40Total = totalCost(g40.slots)
console.log(`\n— budget 40000: total=${g40Total}  types=${slotSummary(g40.slots)}`)
assert(g40Total <= 40_000, 'budget 40k: total ≤ budget', `got ${g40Total}`)
assert((g40.slots['gpu'] ?? []).length > 0, 'budget 40k: GPU present')
assert((g40.slots['psu'] ?? []).length > 0, 'budget 40k: PSU present')
assert((g40.slots['cpu'] ?? []).length > 0, 'budget 40k: CPU present')

// budget 5k → nothing exceeds budget (too small for any full build)
const g5 = buildSuggestion(ENTITIES, RULES, DEFAULT_DOMAIN_CONFIG, { budget: 5_000 })
const g5Total = totalCost(g5.slots)
console.log(`\n— budget 5000: total=${g5Total}`)
assert(g5Total <= 5_000, 'budget 5k: total ≤ budget', `got ${g5Total}`)

// budget 25k → no GPU (all GPU packages exceed 25k), but CPU + PSU present
const g25 = buildSuggestion(ENTITIES, RULES, DEFAULT_DOMAIN_CONFIG, { budget: 25_000 })
const g25Total = totalCost(g25.slots)
console.log(`\n— budget 25000: total=${g25Total}  types=${slotSummary(g25.slots)}`)
assert(g25Total <= 25_000, 'budget 25k: total ≤ budget', `got ${g25Total}`)
assert((g25.slots['cpu'] ?? []).length > 0, 'budget 25k: CPU present')
assert((g25.slots['psu'] ?? []).length > 0, 'budget 25k: PSU present')

// budget 80k → GPU present (RTX4070 fits; RTX4090 needs i9 but RTX4090+i9 > 80k)
const g80 = buildSuggestion(ENTITIES, RULES, DEFAULT_DOMAIN_CONFIG, { budget: 80_000 })
const g80Total = totalCost(g80.slots)
console.log(`\n— budget 80000: total=${g80Total}  types=${slotSummary(g80.slots)}`)
assert(g80Total <= 80_000, 'budget 80k: total ≤ budget', `got ${g80Total}`)
assert((g80.slots['gpu'] ?? []).length > 0, 'budget 80k: GPU present')
assert((g80.slots['psu'] ?? []).length > 0, 'budget 80k: PSU present')

// budget null → GPU present (unconstrained — best build)
const gNull = buildSuggestion(ENTITIES, RULES, DEFAULT_DOMAIN_CONFIG, { budget: null })
console.log(`\n— budget null: types=${slotSummary(gNull.slots)}`)
assert((gNull.slots['gpu'] ?? []).length > 0, 'budget null: GPU present')
assert((gNull.slots['psu'] ?? []).length > 0, 'budget null: PSU present')

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — GPU-first property (spec-chain, not greedy-RAM)
//
//  Old 1D greedy at 40k: picked 2×RAM instead of GPU (wrong)
//  New spec-chain at 40k: picks GPU first, then minimum adequate supporting
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── GPU-first spec-chain property ──')

// 40k must produce a GPU, not inflate RAM
const gpuFirst40 = buildSuggestion(ENTITIES, RULES, CFG, { budget: 40_000 })
assert(
  (gpuFirst40.slots['gpu'] ?? []).length > 0,
  'spec-chain 40k: GPU present (not replaced by extra RAM)',
)
const ramQty40 = (gpuFirst40.slots['ram'] ?? []).reduce((s, i) => s + i.quantity, 0)
assert(ramQty40 <= 1, 'spec-chain 40k: RAM qty ≤ 1 (minimum adequate — not inflated)', `got ${ramQty40}`)

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — TierRule as soft preference (not hard requirement)
//
//  RTX4090 (memory_bus_bit=384 > 312, vram_gb=24 > 16) triggers HIGH_BW_GPU rule
//  → PREFERS CPU with l3_cache_mb > 32 (tried first, desc cost)
//  → If no tier-satisfying CPU is affordable, falls back to any compatible CPU
//  → GPU is NEVER blocked solely because of tier conditions
//
//  Custom entity set: RTX4090 + low-cache CPU only → GPU selects with fallback CPU
//  Custom entity set: RTX4090 + high-cache CPU only → GPU selects with preferred CPU
//  Mixed set: engine picks best GPU + prefers tier-satisfying CPU first
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── TierRule enforcement ──')

const BASE_SUPPORT: Entity[] = [
  {
    id: 301, uuid: 'mb-t1', entity_type: 'motherboard', code: 'MB-T1',
    name: 'Test MB LGA1700', status: 'published',
    attributes: { socket: 'LGA1700', ram_type: 'DDR5', ram_slots: 4, max_ram_gb: 192,
      max_ram_speed_mhz: 7800, tdp_support_w: 300, power_draw_w: 80, unit_cost: 5000 },
  },
  {
    id: 302, uuid: 'ram-t1', entity_type: 'ram', code: 'RAM-T1',
    name: 'Test RAM DDR5', status: 'published',
    attributes: { ram_type: 'DDR5', modules: 2, speed_mhz: 5600, power_draw_w: 5, unit_cost: 3000 },
  },
  {
    id: 303, uuid: 'psu-t1', entity_type: 'psu', code: 'PSU-T1',
    name: 'Test PSU 1200W', status: 'published',
    attributes: { watt_output: 1200, efficiency: '80+ Gold', unit_cost: 5000 },
  },
]

const RTX4090_ENTITY: Entity = {
  id: 304, uuid: 'gpu-t-4090', entity_type: 'gpu', code: 'GPU-T-4090',
  name: 'Test RTX4090', status: 'published',
  attributes: { memory_bus_bit: 384, vram_gb: 24, power_draw_w: 450, pcie_version: '4.0', unit_cost: 50000 },
}

const RTX4070_ENTITY: Entity = {
  id: 305, uuid: 'gpu-t-4070', entity_type: 'gpu', code: 'GPU-T-4070',
  name: 'Test RTX4070', status: 'published',
  attributes: { memory_bus_bit: 192, vram_gb: 12, power_draw_w: 200, pcie_version: '4.0', unit_cost: 20000 },
}

const CPU_LOW_CACHE: Entity = {
  id: 306, uuid: 'cpu-low', entity_type: 'cpu', code: 'CPU-LOW-CACHE',
  name: 'CPU l3=24MB', status: 'published',
  attributes: { socket: 'LGA1700', cores: 14, l3_cache_mb: 24, tdp_w: 181, pcie_version: '5.0', unit_cost: 10000 },
}

const CPU_HIGH_CACHE: Entity = {
  id: 307, uuid: 'cpu-high', entity_type: 'cpu', code: 'CPU-HIGH-CACHE',
  name: 'CPU l3=36MB', status: 'published',
  attributes: { socket: 'LGA1700', cores: 24, l3_cache_mb: 36, tdp_w: 253, pcie_version: '5.0', unit_cost: 15000 },
}

// Case A: RTX4090 + only low-cache CPU → tier preference unfulfilled but GPU still selected (soft rule)
const tierEntitiesA: Entity[] = [RTX4090_ENTITY, CPU_LOW_CACHE, ...BASE_SUPPORT]
const tierResultA = buildSuggestion(tierEntitiesA, RULES, CFG, { budget: 200_000 })
const tierGpuA = (tierResultA.slots['gpu'] ?? [])[0]?.entity.code ?? 'NONE'
const tierCpuA = (tierResultA.slots['cpu'] ?? [])[0]?.entity.code ?? 'NONE'
console.log(`\n— RTX4090 + low-cache CPU only: GPU=${tierGpuA} CPU=${tierCpuA}`)
assert(
  tierGpuA === 'GPU-T-4090',
  'tierRule A: RTX4090 selected even when only low-cache CPU available (tier is preference, not hard block)',
  `got GPU=${tierGpuA}`,
)
assert(
  tierCpuA === 'CPU-LOW-CACHE',
  'tierRule A: falls back to low-cache CPU when no tier-satisfying CPU exists',
  `got CPU=${tierCpuA}`,
)

// Case B: RTX4090 + only high-cache CPU → tier rule satisfied, RTX4090 selected
const tierEntitiesB: Entity[] = [RTX4090_ENTITY, CPU_HIGH_CACHE, ...BASE_SUPPORT]
const tierResultB = buildSuggestion(tierEntitiesB, RULES, CFG, { budget: 200_000 })
const tierGpuB = (tierResultB.slots['gpu'] ?? [])[0]?.entity.code ?? 'NONE'
console.log(`— RTX4090 + high-cache CPU only: GPU=${tierGpuB}`)
assert(
  tierGpuB === 'GPU-T-4090',
  'tierRule B: RTX4090 succeeds (high-cache CPU satisfies l3_cache_mb > 32)',
  `got GPU=${tierGpuB}`,
)

// Case C: RTX4090 + RTX4070 + both CPUs → engine picks RTX4090 (higher tier) with high-cache CPU
const tierEntitiesC: Entity[] = [RTX4090_ENTITY, RTX4070_ENTITY, CPU_LOW_CACHE, CPU_HIGH_CACHE, ...BASE_SUPPORT]
const tierResultC = buildSuggestion(tierEntitiesC, RULES, CFG, { budget: 200_000 })
const tierGpuC = (tierResultC.slots['gpu'] ?? [])[0]?.entity.code ?? 'NONE'
const tierCpuC = (tierResultC.slots['cpu'] ?? [])[0]?.entity.code ?? 'NONE'
console.log(`— both GPUs + both CPUs: GPU=${tierGpuC} CPU=${tierCpuC}`)
assert(
  tierGpuC === 'GPU-T-4090',
  'tierRule C: engine picks RTX4090 (highest tier)',
  `got GPU=${tierGpuC}`,
)
assert(
  tierCpuC === 'CPU-HIGH-CACHE',
  'tierRule C: engine picks high-cache CPU for RTX4090',
  `got CPU=${tierCpuC}`,
)

// Case D: RTX4090 + RTX4070 + low-cache CPU → RTX4090 still wins (tier is soft, not a blocker)
const tierEntitiesD: Entity[] = [RTX4090_ENTITY, RTX4070_ENTITY, CPU_LOW_CACHE, ...BASE_SUPPORT]
const tierResultD = buildSuggestion(tierEntitiesD, RULES, CFG, { budget: 200_000 })
const tierGpuD = (tierResultD.slots['gpu'] ?? [])[0]?.entity.code ?? 'NONE'
const tierCpuD = (tierResultD.slots['cpu'] ?? [])[0]?.entity.code ?? 'NONE'
console.log(`— RTX4090 + RTX4070 + low-cache CPU: GPU=${tierGpuD} CPU=${tierCpuD}`)
assert(
  tierGpuD === 'GPU-T-4090',
  'tierRule D: RTX4090 selected even with low-cache CPU (tier is preference, GPU not demoted)',
  `got GPU=${tierGpuD}`,
)
assert(
  tierCpuD === 'CPU-LOW-CACHE',
  'tierRule D: low-cache CPU used as fallback (no high-cache CPU in pool)',
  `got CPU=${tierCpuD}`,
)

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`)
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
