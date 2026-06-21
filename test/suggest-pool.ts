/**
 * Integration tests for suggest.post.ts candidate pool selection.
 *
 * These tests simulate the server's selectCandidates logic (perSlot approach)
 * using real seed entities and verify that buildSuggestion produces valid builds
 * across all key pin + budget scenarios.
 *
 * selectCandidates mirrors the exact logic in suggest.post.ts:
 *   - perSlot = effectiveMax / numCoreFilledTypes  (no hardcoded ratio numbers)
 *   - anchor (gpu): maxCost ceiling, LIMIT 20
 *   - capacity (psu): maxCost ceiling, LIMIT 50  (position 41 = cheapest 1000W)
 *   - core types: perSlot ceiling, LIMIT 20
 *   - supplemental DDR4 MB when am4Chain: LIMIT 100 (covers all 59 DDR4 boards)
 *   - supplemental LGA1700 CPU when DDR5 RAM pinned: LIMIT 30 (all 26 LGA1700)
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { Entity } from '~/data/types'
import { buildSuggestion, totalCostOf, type DomainConfig, type SlotItem } from '~/engine/suggest'
import { RULES } from '~/data/rules'
import { ENTITY_TYPES, ENTITY_TYPE_LABELS } from '~/data/entityTypes'
import {
  FILL_ORDER, MAX_PER_TYPE, DYNAMIC_MAX_PER_TYPE,
  AGGREGATE_GUARD_TYPES, AGGREGATE_DISPLAY, REQUIRED_TYPES,
  COST_ATTRIBUTE, COST_PRECISION, CAPACITY_FACTOR, SELECTION_ORDER,
  DEFAULT_DOMAIN_CONFIG,
} from '~/composables/simulationConfig'
import { TIER_RULES } from '~/composables/tierRules'

// ── test harness ──────────────────────────────────────────────────────────────

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

// ── engine config ─────────────────────────────────────────────────────────────

const CFG: DomainConfig = {
  fillOrder:           [...FILL_ORDER],
  entityTypes:         [...ENTITY_TYPES],
  entityTypeLabels:    { ...ENTITY_TYPE_LABELS },
  maxPerType:          { ...MAX_PER_TYPE },
  dynamicMaxPerType:   { ...DYNAMIC_MAX_PER_TYPE },
  aggregateGuardTypes: [...AGGREGATE_GUARD_TYPES],
  aggregateDisplay:    { ...AGGREGATE_DISPLAY },
  requiredTypes:       [...REQUIRED_TYPES],
  costAttribute:       COST_ATTRIBUTE,
  costPrecision:       COST_PRECISION,
  tierRules:           [...TIER_RULES],
  anchorType:          'gpu',
  capacityType:        'psu',
  capacityAttribute:   'watt_output',
  loadAttributes:      ['power_draw_w', 'tdp_w'],
  capacityFactor:      CAPACITY_FACTOR,
  selectionOrder:      [...SELECTION_ORDER],
  postFillTypes:       [...(DEFAULT_DOMAIN_CONFIG.postFillTypes ?? [])],
}

// ── load seed entities ────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

function loadSeedEntities(): Entity[] {
  const content = readFileSync(join(__dirname, '../server/database/seed.sql'), 'utf-8')
  const entities: Entity[] = []
  const regex = /^\((\d+),'([^']+)','([^']+)','([^']+)','([^']+)','([^']+)',([\d.]+),'(.+?)'\)[,;]?\s*$/gm
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) {
    const attrs = JSON.parse(m[8])
    attrs.unit_cost = parseFloat(m[7])
    entities.push({
      id:          parseInt(m[1]),
      uuid:        m[2],
      entity_type: m[3],
      code:        m[4],
      name:        m[5],
      status:      m[6] as Entity['status'],
      attributes:  attrs,
    })
  }
  return entities
}

const ALL_ENTITIES = loadSeedEntities()
console.log(`Loaded ${ALL_ENTITIES.length} seed entities\n`)

// ── selectCandidates: mirrors suggest.post.ts logic ───────────────────────────
// This is the NEW architecture: perSlot from engine config, no hardcoded ratios.

function topN(type: string, ceiling: number, n: number): Entity[] {
  return ALL_ENTITIES
    .filter(e =>
      e.entity_type === type &&
      e.status === 'published' &&
      Number(e.attributes.unit_cost) <= ceiling,
    )
    .sort((a, b) => Number(b.attributes.unit_cost) - Number(a.attributes.unit_cost))
    .slice(0, n)
}

function topNByAttr(type: string, attrKey: string, attrVal: string, ceiling: number, n: number): Entity[] {
  return ALL_ENTITIES
    .filter(e => {
      if (e.entity_type !== type || e.status !== 'published') return false
      if (Number(e.attributes.unit_cost) > ceiling) return false
      const val = e.attributes[attrKey]
      return Array.isArray(val) ? val.includes(attrVal) : val === attrVal
    })
    .sort((a, b) => Number(b.attributes.unit_cost) - Number(a.attributes.unit_cost))
    .slice(0, n)
}

function selectCandidates(
  budget: number,
  pinnedEntities: Record<string, SlotItem[]>,
  excluded: Record<string, boolean> = {},
): Entity[] {
  const anchorType   = CFG.anchorType   ?? 'gpu'
  const capacityType = CFG.capacityType ?? 'psu'
  const maxCost      = budget

  const pinnedCostTotal = Object.values(pinnedEntities)
    .flat()
    .reduce((sum, s) => sum + Number(s.entity.attributes.unit_cost ?? 0) * s.quantity, 0)
  const effectiveMax = Math.max(0, budget - pinnedCostTotal)

  // Core types from engine config (excludes anchor and capacity)
  const coreTypes       = ENTITY_TYPES.filter(t => t !== anchorType && t !== capacityType)
  // Types the engine will fill: non-pinned, non-excluded core types
  const coreFilledTypes = coreTypes.filter(t =>
    !excluded[t] && (pinnedEntities[t]?.length ?? 0) === 0,
  )
  // Per-slot ceiling: effectiveMax split equally across all slots to fill.
  // Sum of all slot ceilings = effectiveMax → SSD always has room in budget.
  const perSlot = coreFilledTypes.length > 0
    ? Math.round(effectiveMax / coreFilledTypes.length)
    : effectiveMax

  // Compatibility signals from pinned items
  const pinnedRamType   = pinnedEntities['ram']?.[0]?.entity.attributes['ram_type'] as string | undefined
  const pinnedCpuSocket = pinnedEntities['cpu']?.[0]?.entity.attributes['socket'] as string | undefined
  const pinnedMbSocket  = pinnedEntities['motherboard']?.[0]?.entity.attributes['socket'] as string | undefined
  const mbPinned  = (pinnedEntities['motherboard']?.length ?? 0) > 0
  const cpuPinned = (pinnedEntities['cpu']?.length ?? 0) > 0

  // am4Chain: DDR4/AM4 pinned → supplement with DDR4 MBs at all price points
  const am4Chain = pinnedRamType === 'DDR4' || pinnedCpuSocket === 'AM4' || pinnedMbSocket === 'AM4'
  // DDR5 RAM pinned → supplement with LGA1700 CPUs for tight-budget builds
  const needSuppLga1700Cpu = pinnedRamType === 'DDR5'

  // Main pool
  const mainPool: Entity[] = ENTITY_TYPES.flatMap(type => {
    if (excluded[type] || (pinnedEntities[type]?.length ?? 0) > 0) return []
    if (type === anchorType)   return topN(type, maxCost, 20)
    if (type === capacityType) return topN(type, maxCost, 50)  // LIMIT 50: cheapest 1000W at pos 41
    // SSD is post-filled from remaining budget — needs cheap SSDs (270-890) in pool.
    // 37 total SSDs; LIMIT 40 includes all of them regardless of perSlot ceiling.
    if (type === 'ssd')        return topN(type, perSlot, 40)
    return topN(type, perSlot, 20)
  })

  // Supplemental: DDR4 MBs covering all 59 DDR4 boards (cheapest at position 59)
  const suppMbs: Entity[] = am4Chain && !excluded['motherboard'] && !mbPinned
    ? topNByAttr('motherboard', 'ram_type', 'DDR4', effectiveMax, 100)
    : []

  // Supplemental: LGA1700 CPUs covering all 26 boards
  const suppCpus: Entity[] = needSuppLga1700Cpu && !excluded['cpu'] && !cpuPinned
    ? topNByAttr('cpu', 'socket', 'LGA1700', effectiveMax, 30)
    : []

  // Deduplicate by entity id
  const seenIds = new Set<number>()
  return [
    ...Object.values(pinnedEntities).flat().map(s => s.entity),
    ...[...mainPool, ...suppMbs, ...suppCpus].filter(e => {
      if (seenIds.has(e.id)) return false
      seenIds.add(e.id)
      return true
    }),
  ]
}

// ── seed entity lookups ───────────────────────────────────────────────────────

function byId(id: number): Entity {
  const e = ALL_ENTITIES.find(e => e.id === id)
  if (!e) throw new Error(`Entity id=${id} not in seed`)
  return e
}

// Seed entities used in tests (verified against seed.sql):
const GPU_5070     = byId(607)  // RTX 5070 ZOTAC, 21920, 650W
const RAM_DDR4_32G = byId(180)  // DDR4 32GB BLACKBERRY, 5800, modules=2
const RAM_DDR4_4G  = byId(304)  // DDR4 4GB HYNIX, 805, modules=1
const RAM_DDR5_8G  = byId(206)  // DDR5 8GB CORSAIR, 4540, modules=1
const CPU_AM4_R5500 = byId(107) // Ryzen 5 5500 AM4, 3190, tdp=65W
const CPU_AM4_ATH  = byId(101)  // Athlon 3000G AM4, 1370, tdp=35W

// ── helpers ───────────────────────────────────────────────────────────────────

function slotOf(slots: Record<string, SlotItem[]>, type: string): Entity | undefined {
  return slots[type]?.[0]?.entity
}

function hasType(slots: Record<string, SlotItem[]>, type: string): boolean {
  return (slots[type]?.length ?? 0) > 0
}

function pinned(entity: Entity, qty = 1): SlotItem {
  return { entity, quantity: qty }
}

// ── SECTION 4: perSlot pool selection + engine integration ────────────────────

console.log('\n── perSlot pool selection: GPU-only pin scenarios ──')

// ─── 4A: GPU5070 only @50k — SSD must fit (original user complaint) ───────────
{
  const budget = 50_000
  const pin = { gpu: [pinned(GPU_5070)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const hasSsd = hasType(result.slots, 'ssd')
  console.log(`\n— GPU5070 @50k: total=${total} ssd=${hasSsd} cpu=${slotOf(result.slots,'cpu')?.name?.slice(0,25)}`)
  assert(total <= budget,              '4A GPU5070@50k: total ≤ 50k',             `got ${total}`)
  assert(hasType(result.slots, 'cpu'), '4A GPU5070@50k: CPU present')
  assert(hasType(result.slots, 'psu'), '4A GPU5070@50k: PSU present')
  assert(hasSsd,                       '4A GPU5070@50k: SSD present (key fix)')
  // CPU must NOT be I5-14600K (cost=8940) — it makes SSD unaffordable
  const cpuCost = Number(slotOf(result.slots, 'cpu')?.attributes.unit_cost ?? 0)
  const effMax = budget - 21_920
  const perSlot = Math.round(effMax / 4)
  assert(cpuCost <= perSlot,           '4A GPU5070@50k: CPU cost ≤ perSlot (not overpriced)', `cpu=${cpuCost} perSlot=${perSlot}`)
}

// ─── 4B: GPU5070 only @40k ────────────────────────────────────────────────────
{
  const budget = 40_000
  const pin = { gpu: [pinned(GPU_5070)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  console.log(`\n— GPU5070 @40k: total=${total} ssd=${hasType(result.slots,'ssd')}`)
  assert(total <= budget,              '4B GPU5070@40k: total ≤ 40k', `got ${total}`)
  assert(hasType(result.slots, 'psu'), '4B GPU5070@40k: PSU present')
  assert(hasType(result.slots, 'ssd'), '4B GPU5070@40k: SSD present')
}

// ── SECTION 5: DDR4 pin scenarios (root cause fix) ───────────────────────────

console.log('\n── DDR4 pin scenarios (perSlot + supplemental DDR4 MB) ──')

// ─── 5A: GPU5070 + DDR4-32GB @50k — must use DDR4 MB ─────────────────────────
{
  const budget = 50_000
  const pin = { gpu: [pinned(GPU_5070)], ram: [pinned(RAM_DDR4_32G)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbRamType = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  const mbSocket  = slotOf(result.slots, 'motherboard')?.attributes['socket']
  const cpuSocket = slotOf(result.slots, 'cpu')?.attributes['socket']
  console.log(`\n— GPU5070+DDR4-32G @50k: total=${total} MB.rtype=${mbRamType} MB.sock=${mbSocket} CPU.sock=${cpuSocket}`)
  assert(total <= budget,              '5A DDR4-32G@50k: total ≤ 50k', `got ${total}`)
  assert(mbRamType === 'DDR4',         '5A DDR4-32G@50k: MB is DDR4', `got ${mbRamType}`)
  assert(mbSocket === cpuSocket,       '5A DDR4-32G@50k: MB socket matches CPU socket', `MB=${mbSocket} CPU=${cpuSocket}`)
  assert(hasType(result.slots, 'ssd'), '5A DDR4-32G@50k: SSD present')
}

// ─── 5B: GPU5070 + DDR4-32GB @37k — user's example that must work ─────────────
{
  const budget = 37_000
  const pin = { gpu: [pinned(GPU_5070)], ram: [pinned(RAM_DDR4_32G)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbRamType = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  console.log(`\n— GPU5070+DDR4-32G @37k: total=${total} MB.rtype=${mbRamType}`)
  assert(total <= budget,              '5B DDR4-32G@37k: total ≤ 37k (user scenario)', `got ${total}`)
  assert(mbRamType === 'DDR4',         '5B DDR4-32G@37k: MB is DDR4')
  assert(hasType(result.slots, 'cpu'), '5B DDR4-32G@37k: CPU present')
  assert(hasType(result.slots, 'psu'), '5B DDR4-32G@37k: PSU present')
}

// ─── 5C: GPU5070 + DDR4-32GB @35k — must work (typeBudget×ratio was too low) ──
{
  const budget = 35_000
  const pin = { gpu: [pinned(GPU_5070)], ram: [pinned(RAM_DDR4_32G)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbRamType = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  console.log(`\n— GPU5070+DDR4-32G @35k: total=${total} MB.rtype=${mbRamType} (was failing with ratio×budget)`)
  assert(total <= budget,              '5C DDR4-32G@35k: total ≤ 35k (fix target)', `got ${total}`)
  assert(mbRamType === 'DDR4',         '5C DDR4-32G@35k: MB is DDR4')
  assert(hasType(result.slots, 'cpu'), '5C DDR4-32G@35k: CPU present')
  assert(hasType(result.slots, 'psu'), '5C DDR4-32G@35k: PSU present')
}

// ─── 5D: GPU5070 + DDR4-4GB @35k ─────────────────────────────────────────────
{
  const budget = 35_000
  const pin = { gpu: [pinned(GPU_5070)], ram: [pinned(RAM_DDR4_4G)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbRamType = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  console.log(`\n— GPU5070+DDR4-4G @35k: total=${total} MB.rtype=${mbRamType}`)
  assert(total <= budget,              '5D DDR4-4G@35k: total ≤ 35k', `got ${total}`)
  assert(mbRamType === 'DDR4',         '5D DDR4-4G@35k: MB is DDR4')
  assert(hasType(result.slots, 'ssd'), '5D DDR4-4G@35k: SSD present')
}

// ─── 5E: GPU5070 + DDR4-4GB @50k ─────────────────────────────────────────────
{
  const budget = 50_000
  const pin = { gpu: [pinned(GPU_5070)], ram: [pinned(RAM_DDR4_4G)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbRamType = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  console.log(`\n— GPU5070+DDR4-4G @50k: total=${total} MB.rtype=${mbRamType}`)
  assert(total <= budget,              '5E DDR4-4G@50k: total ≤ 50k', `got ${total}`)
  assert(mbRamType === 'DDR4',         '5E DDR4-4G@50k: MB is DDR4')
  assert(hasType(result.slots, 'ssd'), '5E DDR4-4G@50k: SSD present')
}

// ── SECTION 6: DDR5 pin scenarios ────────────────────────────────────────────

console.log('\n── DDR5 pin scenarios ──')

// ─── 6A: GPU5070 + DDR5-8GB @50k ─────────────────────────────────────────────
{
  const budget = 50_000
  const pin = { gpu: [pinned(GPU_5070)], ram: [pinned(RAM_DDR5_8G)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbRamType = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  console.log(`\n— GPU5070+DDR5-8G @50k: total=${total} MB.rtype=${mbRamType}`)
  assert(total <= budget,              '6A DDR5-8G@50k: total ≤ 50k', `got ${total}`)
  assert(mbRamType === 'DDR5',         '6A DDR5-8G@50k: MB is DDR5', `got ${mbRamType}`)
  assert(hasType(result.slots, 'ssd'), '6A DDR5-8G@50k: SSD present')
}

// ─── 6B: GPU5070 + DDR5-8GB @40k ─────────────────────────────────────────────
{
  const budget = 40_000
  const pin = { gpu: [pinned(GPU_5070)], ram: [pinned(RAM_DDR5_8G)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbRamType = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  console.log(`\n— GPU5070+DDR5-8G @40k: total=${total} MB.rtype=${mbRamType}`)
  assert(total <= budget,              '6B DDR5-8G@40k: total ≤ 40k', `got ${total}`)
  assert(mbRamType === 'DDR5',         '6B DDR5-8G@40k: MB is DDR5', `got ${mbRamType}`)
  assert(hasType(result.slots, 'ssd'), '6B DDR5-8G@40k: SSD present')
}

// ─── 6C: GPU5070 + DDR5-8GB @37k ─────────────────────────────────────────────
{
  const budget = 37_000
  const pin = { gpu: [pinned(GPU_5070)], ram: [pinned(RAM_DDR5_8G)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbRamType = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  console.log(`\n— GPU5070+DDR5-8G @37k: total=${total} MB.rtype=${mbRamType}`)
  assert(total <= budget,              '6C DDR5-8G@37k: total ≤ 37k', `got ${total}`)
  assert(mbRamType === 'DDR5',         '6C DDR5-8G@37k: MB is DDR5', `got ${mbRamType}`)
}

// ── SECTION 7: AM4 CPU pin scenarios ─────────────────────────────────────────

console.log('\n── AM4 CPU pin scenarios (supplemental DDR4 MB) ──')

// ─── 7A: AM4 Ryzen5500 @40k ───────────────────────────────────────────────────
{
  const budget = 40_000
  const pin = { cpu: [pinned(CPU_AM4_R5500)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbRamType = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  const mbSocket  = slotOf(result.slots, 'motherboard')?.attributes['socket']
  console.log(`\n— AM4-Ryzen5500 @40k: total=${total} MB.sock=${mbSocket} MB.rtype=${mbRamType}`)
  assert(total <= budget,              '7A AM4-R5500@40k: total ≤ 40k', `got ${total}`)
  assert(mbSocket === 'AM4',           '7A AM4-R5500@40k: MB is AM4', `got ${mbSocket}`)
  assert(mbRamType === 'DDR4',         '7A AM4-R5500@40k: MB is DDR4 (AM4 only supports DDR4)', `got ${mbRamType}`)
  assert(hasType(result.slots, 'ram'), '7A AM4-R5500@40k: RAM present')
}

// ─── 7B: AM4 Ryzen5500 @30k ───────────────────────────────────────────────────
{
  const budget = 30_000
  const pin = { cpu: [pinned(CPU_AM4_R5500)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbSocket  = slotOf(result.slots, 'motherboard')?.attributes['socket']
  const mbRamType = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  console.log(`\n— AM4-Ryzen5500 @30k: total=${total} MB.sock=${mbSocket}`)
  assert(total <= budget,              '7B AM4-R5500@30k: total ≤ 30k', `got ${total}`)
  assert(mbSocket === 'AM4',           '7B AM4-R5500@30k: MB is AM4', `got ${mbSocket}`)
  assert(mbRamType === 'DDR4',         '7B AM4-R5500@30k: MB is DDR4', `got ${mbRamType}`)
}

// ─── 7C: AM4 Athlon @25k ──────────────────────────────────────────────────────
{
  const budget = 25_000
  const pin = { cpu: [pinned(CPU_AM4_ATH)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const total = totalCostOf(result.slots, CFG)
  const mbSocket  = slotOf(result.slots, 'motherboard')?.attributes['socket']
  console.log(`\n— AM4-Athlon @25k: total=${total} MB.sock=${mbSocket}`)
  assert(total <= budget,              '7C AM4-Athlon@25k: total ≤ 25k', `got ${total}`)
  assert(mbSocket === 'AM4',           '7C AM4-Athlon@25k: MB is AM4', `got ${mbSocket}`)
  assert(hasType(result.slots, 'ram'), '7C AM4-Athlon@25k: RAM present')
  assert(hasType(result.slots, 'psu'), '7C AM4-Athlon@25k: PSU present')
}

// ── SECTION 8: no-pin scenarios ──────────────────────────────────────────────

console.log('\n── no-pin budget sweep ──')

for (const budget of [50_000, 40_000, 30_000]) {
  const candidates = selectCandidates(budget, {})
  const result = buildSuggestion(candidates, RULES, CFG, { budget })
  const total = totalCostOf(result.slots, CFG)
  const hasCpu = hasType(result.slots, 'cpu')
  const hasMb  = hasType(result.slots, 'motherboard')
  const hasRam = hasType(result.slots, 'ram')
  const hasPsu = hasType(result.slots, 'psu')
  const hasSsd = hasType(result.slots, 'ssd')
  const mbRt   = slotOf(result.slots, 'motherboard')?.attributes['ram_type']
  const ramRt  = slotOf(result.slots, 'ram')?.attributes['ram_type']
  console.log(`\n— no-pin @${budget/1000}k: total=${total} cpu=${hasCpu} mb=${hasMb} ram=${hasRam} psu=${hasPsu} ssd=${hasSsd} MB.rtype=${mbRt} RAM.rtype=${ramRt}`)
  assert(total <= budget, `8 no-pin@${budget/1000}k: total ≤ budget`, `got ${total}`)
  assert(hasCpu,          `8 no-pin@${budget/1000}k: CPU present`)
  assert(hasMb,           `8 no-pin@${budget/1000}k: MB present`)
  assert(hasPsu,          `8 no-pin@${budget/1000}k: PSU present`)
  assert(hasSsd,          `8 no-pin@${budget/1000}k: SSD present`)
  // RAM type and MB type must match (pairwise rule)
  if (mbRt && ramRt) {
    const mbRts: string[] = Array.isArray(mbRt) ? mbRt : [mbRt]
    assert(mbRts.includes(String(ramRt)), `8 no-pin@${budget/1000}k: MB.ram_type includes RAM.ram_type`, `MB=${mbRts} RAM=${ramRt}`)
  }
}

// ── SECTION 9: pairwise compatibility verification ───────────────────────────

console.log('\n── pairwise compatibility after perSlot pool selection ──')

// ─── 9A: DDR4 RAM pinned → MB and RAM must be DDR4-compatible ─────────────────
{
  const budget = 50_000
  const pin = { gpu: [pinned(GPU_5070)], ram: [pinned(RAM_DDR4_32G)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const mb  = slotOf(result.slots, 'motherboard')
  const ram = slotOf(result.slots, 'ram') ?? RAM_DDR4_32G  // pinned
  const mbRts: string[] = Array.isArray(mb?.attributes['ram_type'])
    ? mb!.attributes['ram_type'] as string[]
    : [String(mb?.attributes['ram_type'] ?? '')]
  const ramRt = String(RAM_DDR4_32G.attributes['ram_type'])
  assert(
    mbRts.includes(ramRt),
    '9A pairwise: MB.ram_type includes pinned DDR4',
    `MB=${mbRts} RAM=${ramRt}`,
  )
  const mbSocket  = String(mb?.attributes['socket'] ?? '')
  const cpuSocket = String(slotOf(result.slots, 'cpu')?.attributes['socket'] ?? '')
  assert(
    mbSocket === cpuSocket,
    '9A pairwise: MB.socket === CPU.socket',
    `MB=${mbSocket} CPU=${cpuSocket}`,
  )
}

// ─── 9B: AM4 CPU pinned → MB socket must be AM4 ───────────────────────────────
{
  const budget = 40_000
  const pin = { cpu: [pinned(CPU_AM4_R5500)] }
  const candidates = selectCandidates(budget, pin)
  const result = buildSuggestion(candidates, RULES, CFG, { budget, pinned: pin })
  const mbSocket = String(slotOf(result.slots, 'motherboard')?.attributes['socket'] ?? '')
  assert(mbSocket === 'AM4', '9B pairwise: AM4 CPU pinned → MB socket = AM4', `got ${mbSocket}`)
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`)
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
