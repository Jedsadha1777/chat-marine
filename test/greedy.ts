/**
 * Spec-chain engine tests — generic backtracking fill
 *
 * Engine behavior:
 *   GPU: iterate highest→lowest cost; for each, run backtrackFill for remaining types
 *   selectionOrder (RAM→CPU→MB→PSU): each type tried highest-cost first
 *   Tier rules are SOFT PREFERENCES: tier-satisfying candidates sorted before others
 *   PSU: cheapest adequate for total power draw (÷ psuSafetyFactor)
 */

import { ENTITY_TYPES, ENTITY_TYPE_LABELS } from '~/data/entityTypes'
import type { Entity } from '~/data/types'
import { RULES } from '~/data/rules'
import { buildSuggestion, type DomainConfig } from '~/engine/suggest'
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

// ── shared inline support components ─────────────────────────────────────────

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

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — GPU-first spec-chain property
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── GPU-first spec-chain property ──')

const gpuFirst = buildSuggestion(
  [RTX4070_ENTITY, CPU_HIGH_CACHE, ...BASE_SUPPORT],
  RULES, CFG, { budget: 100_000 },
)
assert((gpuFirst.slots['gpu'] ?? []).length > 0, 'spec-chain: GPU present (not replaced by extra RAM)')
const ramQty = (gpuFirst.slots['ram'] ?? []).reduce((s, i) => s + i.quantity, 0)
assert(ramQty <= 1, 'spec-chain: RAM qty ≤ 1 (minimum adequate — not inflated)', `got ${ramQty}`)

// budget too tight → no GPU, but total within budget
const tiny = buildSuggestion(
  [RTX4090_ENTITY, CPU_LOW_CACHE, ...BASE_SUPPORT],
  RULES, CFG, { budget: 5_000 },
)
const tinyTotal = Object.values(tiny.slots).flatMap(s => s)
  .reduce((sum, s) => sum + Number(s.entity.attributes['unit_cost'] ?? 0) * s.quantity, 0)
assert(tinyTotal <= 5_000, 'budget 5k: total ≤ budget', `got ${tinyTotal}`)

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — TierRule as soft preference (not hard requirement)
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── TierRule enforcement ──')

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

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — DDR4 candidate pool selection (server-layer bug reproduction)
// ══════════════════════════════════════════════════════════════════════════════
//
// Bug in suggest.post.ts: typeBudget = budget × TYPE_RATIO
//   budget=50000, MB ratio=0.15 → typeBudget=7500
//   Top-20 MBs within 7500 (ORDER BY unit_cost DESC) are ALL DDR5 (AM5/LGA1851/LGA1700+DDR5)
//   DDR4 MBs appear at position 67+ → cut off by LIMIT 20 → absent from engine pool
//   Engine's pairwise RAM_TYPE_MATCH rejects all DDR5 MBs when DDR4 RAM is pinned → empty build
//
// Fix in suggest.post.ts: effectiveBudget = budget − pinnedCost for non-PSU types
//   GPU(21920)+RAM(1860) pinned → effectiveBudget=26220 → MB typeBudget=3933
//   At 3933 ceiling, only ~16 DDR5 boards fit → LGA1700+DDR4 boards appear at positions 11&17
//   Engine finds LGA1700 CPU + LGA1700+DDR4 MB + DDR4 RAM → valid pairwise chain

console.log('\n── DDR4 pin + GPU: effectiveBudget candidate selection (server bug) ──')

const GPU_5070_ENTITY: Entity = {
  id: 310, uuid: 'gpu-5070', entity_type: 'gpu', code: 'GPU-5070',
  name: 'RTX 5070 12GB', status: 'published',
  attributes: { vram_gb: 12, memory_bus_bit: 192, power_draw_w: 650, pcie_version: '5.0', unit_cost: 21920 },
}

const DDR4_RAM_ENTITY: Entity = {
  id: 311, uuid: 'ram-ddr4', entity_type: 'ram', code: 'RAM-DDR4',
  name: 'DDR4 8GB', status: 'published',
  attributes: { ram_type: 'DDR4', modules: 1, speed_mhz: 3200, power_draw_w: 5, unit_cost: 1860 },
}

const MB_LGA1700_DDR5_ONLY: Entity = {
  id: 312, uuid: 'mb-lga1700-ddr5', entity_type: 'motherboard', code: 'MB-LGA1700-DDR5',
  name: 'LGA1700 DDR5 MB (expensive, fills top-20)', status: 'published',
  attributes: { socket: 'LGA1700', ram_type: 'DDR5', ram_slots: 4, max_ram_gb: 192,
    tdp_support_w: 300, power_draw_w: 80, unit_cost: 6690 },
}

const MB_LGA1700_DDR4: Entity = {
  id: 313, uuid: 'mb-lga1700-ddr4', entity_type: 'motherboard', code: 'MB-LGA1700-DDR4',
  name: 'LGA1700 DDR4 MB (enters pool only when effectiveBudget used)', status: 'published',
  attributes: { socket: 'LGA1700', ram_type: 'DDR4', ram_slots: 4, max_ram_gb: 128,
    tdp_support_w: 200, power_draw_w: 30, unit_cost: 3655 },
}

const CPU_LGA1700_MID: Entity = {
  id: 314, uuid: 'cpu-i5-12400f', entity_type: 'cpu', code: 'CPU-I5-12400F',
  name: 'Core i5-12400F LGA1700', status: 'published',
  attributes: { socket: 'LGA1700', cores: 6, l3_cache_mb: 18, tdp_w: 65, pcie_version: '5.0', unit_cost: 4890 },
}

const PSU_1000W_ENTITY: Entity = {
  id: 315, uuid: 'psu-1k', entity_type: 'psu', code: 'PSU-1000W',
  name: 'PSU 1000W Gold', status: 'published',
  attributes: { watt_output: 1000, efficiency: '80+ Gold', unit_cost: 3420 },
}

const ddr4PinnedInput = {
  budget: 50_000,
  pinned: {
    gpu: [{ entity: GPU_5070_ENTITY, quantity: 1 }],
    ram: [{ entity: DDR4_RAM_ENTITY, quantity: 1 }],
  },
}

// Case A: DDR5-only pool — reproduces bug (what the BUGGY server sends: typeBudget=7500, all top-20 DDR5)
// Engine correctly rejects all DDR5 MBs via pairwise RAM_TYPE_MATCH → empty MB slot
const ddr4BugPool: Entity[] = [GPU_5070_ENTITY, DDR4_RAM_ENTITY, CPU_LGA1700_MID, MB_LGA1700_DDR5_ONLY, PSU_1000W_ENTITY]
const ddr4BugResult = buildSuggestion(ddr4BugPool, RULES, CFG, ddr4PinnedInput)
const bugMbSlots = ddr4BugResult.slots['motherboard'] ?? []
console.log(`\n— bug pool (DDR5 only): MB=${bugMbSlots.map(s => s.entity.code)}, CPU=${(ddr4BugResult.slots['cpu'] ?? []).map(s => s.entity.code)}`)
assert(
  bugMbSlots.length === 0,
  'bug repro: DDR5-only pool + pinned DDR4 RAM → no MB found (pairwise rejects all DDR5)',
  `got MB=${bugMbSlots.map(s => s.entity.code)}`,
)

// Case B: DDR4 MB added — simulates FIXED server (effectiveBudget lowers MB typeBudget: 7500→3933)
// At 3933 ceiling, LGA1700+DDR4 boards enter the top-20 pool → engine finds compatible MB
const ddr4FixPool: Entity[] = [GPU_5070_ENTITY, DDR4_RAM_ENTITY, CPU_LGA1700_MID, MB_LGA1700_DDR5_ONLY, MB_LGA1700_DDR4, PSU_1000W_ENTITY]
const ddr4FixResult = buildSuggestion(ddr4FixPool, RULES, CFG, ddr4PinnedInput)
const fixMbSlots = ddr4FixResult.slots['motherboard'] ?? []
const fixTotal = Object.values(ddr4FixResult.slots).flat()
  .reduce((sum, s) => sum + Number(s.entity.attributes['unit_cost'] ?? 0) * s.quantity, 0)
console.log(`— fix pool (DDR4 MB included): MB=${fixMbSlots.map(s => s.entity.code)}, total=${fixTotal}`)
assert(
  fixMbSlots.length > 0,
  'fix state: DDR4 MB in pool + pinned DDR4 RAM → MB found',
  `got MB=${fixMbSlots.map(s => s.entity.code)}`,
)
assert(
  fixMbSlots[0]?.entity.attributes['ram_type'] === 'DDR4',
  'fix state: selected MB is DDR4-compatible',
  `got ram_type=${fixMbSlots[0]?.entity.attributes['ram_type']}`,
)
assert(fixTotal <= 50_000, 'fix state: total within budget', `got ${fixTotal}`)

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`)
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
