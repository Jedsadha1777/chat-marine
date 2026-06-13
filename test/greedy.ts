/**
 * Greedy spec-distribution test — TDD สำหรับ selectionStrategyPerType
 *
 * ปัญหาเดิม: engine หยิบ RAM/MB แพงสุดจนงบ PSU ไม่พอ → ไม่มี GPU หรือ PSU
 * วิธีแก้  : Rule ความโลภแยกต่างหาก — selectionStrategyPerType
 *            { ram: 'lowest_cost', psu: 'lowest_cost' }
 *            + hardFloorMin { psu: 3990 } สำรองงบ PSU ขั้นต่ำ
 *
 * RED (baseline ไม่มี Rule): GPU หาย / PSU หาย / repair ได้ no-GPU build
 * GREEN (with Rule)        : GPU + PSU + isValid ทุก budget range
 */

import { ENTITIES, ENTITY_TYPES, ENTITY_TYPE_LABELS } from '~/data/entities'
import type { Entity } from '~/data/types'
import { RULES } from '~/data/rules'
import { buildSuggestion, type DomainConfig } from '~/engine/suggest'
import { DEFAULT_DOMAIN_CONFIG } from '~/composables/domainConfig'
import {
  FILL_ORDER, MAX_PER_TYPE, DYNAMIC_MAX_PER_TYPE,
  QUANTITY_MODE, QUANTITY_MODE_PER_TYPE,
  BUDGET_FLOOR_PER_TYPE, STACK_DISTRIBUTE_MODE,
  AGGREGATE_GUARD_TYPES, AGGREGATE_DISPLAY, REQUIRED_TYPES,
  COST_ATTRIBUTE, COST_PRECISION,
} from '~/composables/simulationConfig'

// ── baseline: ไม่มี Rule ความโลภเลย ────────────────────────────────────────
const NO_RULE_CONFIG: DomainConfig = {
  fillOrder:                [...FILL_ORDER],
  entityTypes:              [...ENTITY_TYPES],
  entityTypeLabels:         { ...ENTITY_TYPE_LABELS },
  maxPerType:               { ...MAX_PER_TYPE },
  dynamicMaxPerType:        { ...DYNAMIC_MAX_PER_TYPE },
  quantityMode:             QUANTITY_MODE,
  quantityModePerType:      { ...QUANTITY_MODE_PER_TYPE },
  selectionStrategy:        'highest_cost',
  selectionStrategyPerType: {},
  budgetFloorPerType:       { ...BUDGET_FLOOR_PER_TYPE },
  hardFloorMin:             {},
  stackDistributeMode:      STACK_DISTRIBUTE_MODE,
  aggregateGuardTypes:      [...AGGREGATE_GUARD_TYPES],
  aggregateDisplay:         { ...AGGREGATE_DISPLAY },
  requiredTypes:            [...REQUIRED_TYPES],
  costAttribute:            COST_ATTRIBUTE,
  costPrecision:            COST_PRECISION,
}

function totalCost(slots: Record<string, { entity: { attributes: Record<string, unknown> }; quantity: number }[]>): number {
  return Object.values(slots).flatMap((s) => s)
    .reduce((sum, s) => sum + Number(s.entity.attributes['unit_cost'] ?? 0) * s.quantity, 0)
}

function slotSummary(slots: Record<string, { entity: { attributes: Record<string, unknown>; name?: string }; quantity: number }[]>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(slots).filter(([, v]) => v.length > 0).map(([k, v]) => [k, v.length])),
  )
}

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

// ══════════════════════════════════════════════════════════════════════════════
//  RED: baseline ไม่มี Rule ความโลภ
//  แสดงว่าไม่มี Rule → GPU/PSU หาย
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── RED baseline (ไม่มี Rule ความโลภ) ──')
const red40 = buildSuggestion(ENTITIES, RULES, NO_RULE_CONFIG, { budget: 40_000 })
const redGpu = (red40.slots['gpu'] ?? []).length > 0
const redPsu = (red40.slots['psu'] ?? []).length > 0
const redTotal = totalCost(red40.slots)
console.log(`   budget 40k → gpu:${redGpu ? 1 : 0}  psu:${redPsu ? 1 : 0}  total=${redTotal}`)
console.log(`   types=${slotSummary(red40.slots)}`)
if (!redGpu || !redPsu) {
  console.log('   ↑ ยืนยัน RED: ไม่มี Rule → GPU หรือ PSU หาย (ถูกต้องที่ fail)')
} else {
  console.log('   ⚠️  baseline already produces GPU+PSU — adjust RED scenario')
}

// ══════════════════════════════════════════════════════════════════════════════
//  GREEN: DEFAULT_DOMAIN_CONFIG (production config จาก chat-marine)
//  ต้องมี selectionStrategyPerType {ram:'lowest_cost', psu:'lowest_cost'}
//  และ hardFloorMin {psu:3990}
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── GREEN: DEFAULT_DOMAIN_CONFIG ──')

// budget 40k → GPU + PSU ต้องครบ (core fix)
const g40 = buildSuggestion(ENTITIES, RULES, DEFAULT_DOMAIN_CONFIG, { budget: 40_000 })
const g40Total = totalCost(g40.slots)
console.log(`\n— budget 40000: total=${g40Total}`)
console.log(`  types=${slotSummary(g40.slots)}`)
assert(g40Total <= 40_000, 'budget 40k: total <= budget', `got ${g40Total}`)
assert((g40.slots['gpu'] ?? []).length > 0, 'budget 40k: GPU present')
assert((g40.slots['psu'] ?? []).length > 0, 'budget 40k: PSU present')

const ramQty40 = (g40.slots['ram'] ?? []).reduce((s, i) => s + i.quantity, 0)
const ramModules40 = (g40.slots['ram'] ?? []).reduce(
  (s, i) => s + Number(i.entity.attributes['modules'] ?? 1) * i.quantity, 0,
)
console.log(`  ram qty=${ramQty40}  modules=${ramModules40}`)
assert(
  (g40.slots['gpu'] ?? []).length > 0,
  'budget 40k: GPU ไม่ถูกแทนด้วย 2×RAM (Rule ความโลภทำงาน)',
)

// budget 5k → ไม่ overflow
const g5 = buildSuggestion(ENTITIES, RULES, DEFAULT_DOMAIN_CONFIG, { budget: 5_000 })
const g5Total = totalCost(g5.slots)
console.log(`\n— budget 5000: total=${g5Total}`)
assert(g5Total <= 5_000, 'budget 5k: total <= budget', `got ${g5Total}`)

// budget 25k → CPU+MB+RAM+PSU (no GPU, but all required present)
const g25 = buildSuggestion(ENTITIES, RULES, DEFAULT_DOMAIN_CONFIG, { budget: 25_000 })
const g25Total = totalCost(g25.slots)
console.log(`\n— budget 25000: total=${g25Total}`)
console.log(`  types=${slotSummary(g25.slots)}`)
assert(g25Total <= 25_000, 'budget 25k: total <= budget', `got ${g25Total}`)
assert((g25.slots['cpu'] ?? []).length > 0, 'budget 25k: CPU present')
assert((g25.slots['psu'] ?? []).length > 0, 'budget 25k: PSU present')

// budget 80k → GPU + valid (งบสูงพอ)
const g80 = buildSuggestion(ENTITIES, RULES, DEFAULT_DOMAIN_CONFIG, { budget: 80_000 })
const g80Total = totalCost(g80.slots)
console.log(`\n— budget 80000: total=${g80Total}`)
console.log(`  types=${slotSummary(g80.slots)}`)
assert(g80Total <= 80_000, 'budget 80k: total <= budget', `got ${g80Total}`)
assert((g80.slots['gpu'] ?? []).length > 0, 'budget 80k: GPU present')
assert((g80.slots['psu'] ?? []).length > 0, 'budget 80k: PSU present')

// ══════════════════════════════════════════════════════════════════════════════
//  UPGRADE RULE TEST — Rule ความโลภแยกต่างหาก (upgradePass)
//
//  Scenario: budget=28000, custom entities, no rules
//  Engine via repair → GPU_LOW(10000) + 2×RAM(2000 each)   total=27000 rem=1000
//  upgradePass: trade 1 RAM kit (2000) + remaining (1000) = 3000 ≥ GPU diff (3000)
//  → upgrade GPU_LOW → GPU_HIGH(13000) + 1×RAM
//
//  RED  (no upgradeOrder): GPU=GPU-U-LOW,  RAM qty=2
//  GREEN (with upgradeOrder=['gpu']): GPU=GPU-U-HIGH, RAM qty=1
// ══════════════════════════════════════════════════════════════════════════════

const UPGRADE_ENTITIES: Entity[] = [
  {
    id: 201, uuid: 'mb-u1', entity_type: 'motherboard', code: 'MB-U1',
    name: 'Test MB 4-Slot', status: 'published',
    attributes: { socket: 'AM4', ram_type: 'DDR4', ram_slots: 4, max_ram_gb: 128, max_ram_speed_mhz: 3200, tdp_support_w: 200, power_draw_w: 50, unit_cost: 5000 },
  },
  {
    id: 202, uuid: 'cpu-u1', entity_type: 'cpu', code: 'CPU-U1',
    name: 'Test CPU', status: 'published',
    attributes: { socket: 'AM4', cores: 8, tdp_w: 100, pcie_version: '4.0', integrated_gpu: false, unit_cost: 5000 },
  },
  {
    id: 203, uuid: 'ram-u1', entity_type: 'ram', code: 'RAM-U1',
    name: 'Test RAM (2 modules)', status: 'published',
    attributes: { ram_type: 'DDR4', modules: 2, speed_mhz: 3200, power_draw_w: 5, unit_cost: 2000 },
  },
  {
    id: 204, uuid: 'gpu-u-low', entity_type: 'gpu', code: 'GPU-U-LOW',
    name: 'Test GPU Low', status: 'published',
    attributes: { power_draw_w: 100, pcie_version: '4.0', unit_cost: 10000 },
  },
  {
    id: 205, uuid: 'gpu-u-high', entity_type: 'gpu', code: 'GPU-U-HIGH',
    name: 'Test GPU High', status: 'published',
    attributes: { power_draw_w: 150, pcie_version: '4.0', unit_cost: 13000 },
  },
  {
    id: 206, uuid: 'psu-u1', entity_type: 'psu', code: 'PSU-U1',
    name: 'Test PSU', status: 'published',
    attributes: { watt_output: 500, efficiency: '80+ Gold', unit_cost: 3000 },
  },
]

// Config WITHOUT upgradeOrder (baseline — no upgrade pass)
const NO_UPGRADE_CFG: DomainConfig = {
  fillOrder:                [...FILL_ORDER],
  entityTypes:              [...ENTITY_TYPES],
  entityTypeLabels:         { ...ENTITY_TYPE_LABELS },
  maxPerType:               { ...MAX_PER_TYPE },
  dynamicMaxPerType:        { ...DYNAMIC_MAX_PER_TYPE },
  quantityMode:             QUANTITY_MODE,
  quantityModePerType:      { ...QUANTITY_MODE_PER_TYPE },
  selectionStrategy:        'highest_cost',
  selectionStrategyPerType: { ram: 'lowest_cost' },
  budgetFloorPerType:       {},
  hardFloorMin:             {},
  stackDistributeMode:      STACK_DISTRIBUTE_MODE,
  aggregateGuardTypes:      [...AGGREGATE_GUARD_TYPES],
  aggregateDisplay:         { ...AGGREGATE_DISPLAY },
  requiredTypes:            [...REQUIRED_TYPES],
  costAttribute:            COST_ATTRIBUTE,
  costPrecision:            COST_PRECISION,
  // upgradeOrder NOT SET
}

// Config WITH upgradeOrder=['gpu'] — upgrade rule fires
const WITH_UPGRADE_CFG: DomainConfig = {
  ...NO_UPGRADE_CFG,
  upgradeOrder: ['gpu'],
}

const UPGRADE_BUDGET = 28_000

console.log('\n── UPGRADE RULE: Rule ความโลภแยกต่างหาก ──')

// Baseline (no upgradeOrder) — confirms engine stacks 2×RAM with GPU_LOW via repair
const noUpgrade = buildSuggestion(UPGRADE_ENTITIES, [], NO_UPGRADE_CFG, { budget: UPGRADE_BUDGET })
const noUpgradeGpu  = (noUpgrade.slots['gpu'] ?? [])[0]?.entity.code ?? 'NONE'
const noUpgradeRam  = (noUpgrade.slots['ram'] ?? []).reduce((s, i) => s + i.quantity, 0)
const noUpgradeTotal = totalCost(noUpgrade.slots)
console.log(`\n— WITHOUT upgradeOrder (baseline):`)
console.log(`  GPU=${noUpgradeGpu}  RAM qty=${noUpgradeRam}  total=${noUpgradeTotal}`)
assert(noUpgradeGpu === 'GPU-U-LOW',  'upgradeRule baseline: GPU is LOW tier (engine stacks RAM instead)')
assert(noUpgradeRam === 2,            'upgradeRule baseline: RAM qty=2 (engine fills both slots)')

// With upgradeOrder=['gpu'] — upgrade rule should trade 1 RAM kit → GPU upgrade
const withUpgrade = buildSuggestion(UPGRADE_ENTITIES, [], WITH_UPGRADE_CFG, { budget: UPGRADE_BUDGET })
const withUpgradeGpu  = (withUpgrade.slots['gpu'] ?? [])[0]?.entity.code ?? 'NONE'
const withUpgradeRam  = (withUpgrade.slots['ram'] ?? []).reduce((s, i) => s + i.quantity, 0)
const withUpgradeTotal = totalCost(withUpgrade.slots)
console.log(`\n— WITH upgradeOrder=['gpu']:`)
console.log(`  GPU=${withUpgradeGpu}  RAM qty=${withUpgradeRam}  total=${withUpgradeTotal}`)
assert(withUpgradeGpu === 'GPU-U-HIGH', 'upgradeRule: GPU upgraded to HIGH tier (Rule ความโลภทำงาน)')
assert(withUpgradeRam === 1,            'upgradeRule: RAM qty=1 (traded 1 kit for GPU upgrade)')
assert(withUpgradeTotal <= UPGRADE_BUDGET, `upgradeRule: total (${withUpgradeTotal}) <= budget (${UPGRADE_BUDGET})`)

// ── summary ──
console.log(`\n${'═'.repeat(50)}`)
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
