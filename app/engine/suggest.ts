import type {
  Entity,
  CompatibilityRule,
  SimulationItem,
  ValidationIssue,
  BomItem,
} from '~/data/types'
import { runPairwise } from '~/engine/pairwise'
import { runAggregate, getAggregateDetail } from '~/engine/aggregate'

export interface DynamicMaxCfg {
  source_type: string
  source_attribute: string
  capacity_attribute?: string
  fallback: number
}

export interface DomainConfig {
  fillOrder: string[]
  entityTypes: string[]
  entityTypeLabels: Record<string, string>
  maxPerType: Partial<Record<string, number>>
  dynamicMaxPerType: Partial<Record<string, DynamicMaxCfg>>
  quantityMode: 'unique' | 'stack'
  quantityModePerType: Partial<Record<string, 'unique' | 'stack'>>
  selectionStrategy: 'highest_cost' | 'lowest_cost' | 'best_fit'
  selectionStrategyPerType?: Partial<Record<string, 'highest_cost' | 'lowest_cost' | 'best_fit'>>
  budgetFloorPerType: Partial<Record<string, number>>
  hardFloorMin: Partial<Record<string, number>>
  stackDistributeMode: 'sequential' | 'round_robin'
  aggregateGuardTypes: string[]
  aggregateDisplay: { primary: string; safety: string | null }
  requiredTypes: string[]
  costAttribute: string
  costPrecision: number
  maxRepairIterations?: number
  upgradeOrder?: string[]
}

export interface SlotItem {
  entity: Entity
  quantity: number
}

export interface SuggestInput {
  budget: number | null
  pinned?: Partial<Record<string, SlotItem[]>>
  excluded?: Partial<Record<string, boolean>>
  blockedIds?: Iterable<number>
}

export interface SuggestResult {
  slots: Record<string, SlotItem[]>
  overflow: boolean
  repairedBlockedIds: number[]
}

function unitCost(e: Entity, cfg: DomainConfig): number {
  const raw = e.attributes[cfg.costAttribute] ?? 0
  return parseFloat(Number(raw).toFixed(cfg.costPrecision))
}

function slotCost(s: SlotItem, cfg: DomainConfig): number {
  return unitCost(s.entity, cfg) * s.quantity
}

function emptySlots(cfg: DomainConfig): Record<string, SlotItem[]> {
  return Object.fromEntries(cfg.entityTypes.map((t) => [t, []]))
}

export function toSimItems(slots: Record<string, SlotItem[]>, cfg: DomainConfig): SimulationItem[] {
  let id = 0
  return cfg.entityTypes.flatMap((t) =>
    (slots[t] ?? []).map((s) => ({ id: ++id, entity: s.entity, quantity: s.quantity })),
  )
}

function sortCandidates(
  candidates: Entity[],
  remaining: number,
  cfg: DomainConfig,
  strategy?: 'highest_cost' | 'lowest_cost' | 'best_fit',
): Entity[] {
  const copy = [...candidates]
  switch (strategy ?? cfg.selectionStrategy) {
    case 'lowest_cost':
      return copy.sort((a, b) => unitCost(a, cfg) - unitCost(b, cfg))
    case 'best_fit':
      return copy.sort(
        (a, b) => Math.abs(unitCost(a, cfg) - remaining) - Math.abs(unitCost(b, cfg) - remaining),
      )
    default:
      return copy.sort((a, b) => unitCost(b, cfg) - unitCost(a, cfg))
  }
}

function maxFor(type: string, cfg: DomainConfig, slots?: Record<string, SlotItem[]>): number {
  if (cfg.maxPerType[type] !== undefined) return cfg.maxPerType[type]!
  const dynCfg = cfg.dynamicMaxPerType[type]
  if (dynCfg && slots) {
    const sourceItems = slots[dynCfg.source_type] ?? []
    if (sourceItems.length > 0) {
      const val = sourceItems[0]?.entity.attributes[dynCfg.source_attribute]
      if (val !== undefined && val !== null) return Number(val)
    }
    return dynCfg.fallback
  }
  return Infinity
}

function uniqueEntities(entities: Entity[]): Entity[] {
  const seen = new Set<number>()
  return entities.filter((e) => { if (seen.has(e.id)) return false; seen.add(e.id); return true })
}

function usedCapacity(type: string, items: SlotItem[], cfg: DomainConfig): number {
  const dynCfg = cfg.dynamicMaxPerType[type]
  if (!dynCfg?.capacity_attribute) {
    return items.reduce((sum, s) => sum + s.quantity, 0)
  }
  const attr = dynCfg.capacity_attribute
  return items.reduce((sum, s) => sum + Number(s.entity.attributes[attr] ?? 1) * s.quantity, 0)
}

function remainingCapacity(type: string, items: SlotItem[], limit: number, cfg: DomainConfig): number {
  return limit - usedCapacity(type, items, cfg)
}

interface FloorResult {
  floor: Record<string, number>
  overflow: boolean
}

function computeFloor(totalBudget: number, freeTypes: string[], cfg: DomainConfig): FloorResult {
  const raw = Object.fromEntries(
    freeTypes.map((t) => [t, totalBudget * (cfg.budgetFloorPerType[t] ?? 0)]),
  ) as Record<string, number>

  const totalHardMin = freeTypes.reduce((s, t) => s + (cfg.hardFloorMin[t] ?? 0), 0)
  const overflow = totalHardMin > totalBudget

  const total = freeTypes.reduce((s, t) => s + (raw[t] ?? 0), 0)
  let floor: Record<string, number>

  if (total > totalBudget && total > 0) {
    const scale = totalBudget / total
    floor = Object.fromEntries(
      freeTypes.map((t) => {
        const hardMin = cfg.hardFloorMin[t] ?? 0
        const scaled = (raw[t] ?? 0) * scale
        return [t, Math.min(totalBudget, Math.max(hardMin, scaled))]
      }),
    ) as Record<string, number>
  } else {
    floor = Object.fromEntries(
      freeTypes.map((t) => [t, Math.max(raw[t] ?? 0, cfg.hardFloorMin[t] ?? 0)]),
    ) as Record<string, number>
  }

  const totalFloor = freeTypes.reduce((s, t) => s + (floor[t] ?? 0), 0)
  if (totalFloor > totalBudget && totalFloor > 0) {
    const scale = totalBudget / totalFloor
    for (const t of freeTypes) floor[t] = Math.floor((floor[t] ?? 0) * scale)
  }

  return { floor, overflow }
}

const _pwCacheByRules = new WeakMap<CompatibilityRule[], Map<string, boolean>>()

function cachedPairwise(candidate: Entity, others: Entity[], rules: CompatibilityRule[]): boolean {
  let cache = _pwCacheByRules.get(rules)
  if (!cache) { cache = new Map(); _pwCacheByRules.set(rules, cache) }

  const errorRules = rules.filter(
    (r) => r.is_active && r.check_type === 'pairwise' && r.severity === 'error',
  )
  const uniqueOthers = uniqueEntities(others)

  for (const rule of errorRules) {
    for (const other of uniqueOthers) {
      const key = `${rule.id}:${candidate.id}:${other.id}`
      if (!cache.has(key)) {
        const ok = runPairwise(rule, [candidate, other]).length === 0
        cache.set(key, ok)
        cache.set(`${rule.id}:${other.id}:${candidate.id}`, ok)
      }
      if (!cache.get(key)) return false
    }
  }
  return true
}

function passesAggregate(items: SimulationItem[], rules: CompatibilityRule[]): boolean {
  return rules.filter(
    (r) => r.is_active && r.check_type === 'aggregate' && r.severity === 'error',
  ).every((rule) => runAggregate(rule, items, {}).length === 0)
}

function passesAggregateWithQty(
  result: Record<string, SlotItem[]>,
  type: string,
  entity: Entity,
  qty: number,
  rules: CompatibilityRule[],
  cfg: DomainConfig,
): boolean {
  const testSlots = {
    ...result,
    [type]: [...(result[type] ?? []), { entity, quantity: qty }],
  }
  return passesAggregate(toSimItems(testSlots, cfg), rules)
}

function greedyFill(
  entities: Entity[],
  rules: CompatibilityRule[],
  cfg: DomainConfig,
  input: Required<Pick<SuggestInput, 'budget'>> & {
    pinned: Record<string, SlotItem[]>
    excluded: Record<string, boolean>
    blockedIds: Set<number>
  },
): { slots: Record<string, SlotItem[]>; overflow: boolean } {
  const { budget, pinned, excluded, blockedIds } = input
  const result = emptySlots(cfg)

  for (const type of cfg.entityTypes) {
    result[type] = excluded[type] ? [] : (pinned[type] ?? []).map((s) => ({ ...s }))
  }

  const pinnedCost = cfg.entityTypes
    .filter((t) => !excluded[t])
    .reduce((sum, t) => sum + (result[t] ?? []).reduce((s, i) => s + slotCost(i, cfg), 0), 0)

  const remaining = budget !== null ? budget - pinnedCost : Infinity
  const freeTypes = cfg.fillOrder.filter((t) => !excluded[t] && (result[t] ?? []).length === 0)

  const { floor, overflow } = budget !== null
    ? computeFloor(remaining, freeTypes, cfg)
    : {
      floor: Object.fromEntries(cfg.entityTypes.map((t) => [t, 0])) as Record<string, number>,
      overflow: false,
    }

  const totalFloor = freeTypes.reduce((s, t) => s + (floor[t] ?? 0), 0)
  let fillBudget = Math.max(0, remaining - totalFloor)

  for (const type of cfg.fillOrder) {
    if (excluded[type]) continue
    if ((pinned[type] ?? []).length > 0) continue
    const limit = maxFor(type, cfg, result)
    if (usedCapacity(type, result[type] ?? [], cfg) >= limit) continue

    const filled = cfg.entityTypes.flatMap((t) => (result[t] ?? []).map((s) => s.entity))
    const typeBudget = fillBudget + (floor[type] ?? 0)

    const filtered = entities.filter((e) => {
      if (e.status !== 'published') return false
      if (e.entity_type !== type) return false
      if (unitCost(e, cfg) > typeBudget) return false
      if (blockedIds.has(e.id) && !(pinned[type] ?? []).some((s) => s.entity.id === e.id)) return false
      if (!cachedPairwise(e, filled, rules)) return false
      if (cfg.aggregateGuardTypes.includes(type)) {
        if (!passesAggregateWithQty(result, type, e, 1, rules, cfg)) return false
      }
      return true
    })

    const sorted = sortCandidates(filtered, typeBudget, cfg, cfg.selectionStrategyPerType?.[type])
    const effectiveMode = cfg.quantityModePerType[type] ?? cfg.quantityMode

    if (effectiveMode === 'stack') {
      const dynCapCfg = cfg.dynamicMaxPerType[type]
      const capAttr = dynCapCfg?.capacity_attribute

      if (cfg.stackDistributeMode === 'round_robin') {
        let typeRemaining = typeBudget
        let added = true
        while (added && usedCapacity(type, result[type] ?? [], cfg) < limit && typeRemaining >= 0) {
          added = false
          for (const e of sorted) {
            const capPerKit = capAttr ? Number(e.attributes[capAttr] ?? 1) : 1
            const remCap = remainingCapacity(type, result[type] ?? [], limit, cfg)
            if (remCap < capPerKit || remCap <= 0) continue
            const c = unitCost(e, cfg)
            if (c > 0 && c > typeRemaining) continue
            if (cfg.aggregateGuardTypes.includes(type)) {
              if (!passesAggregateWithQty(result, type, e, 1, rules, cfg)) continue
            }
            const typeSlot = (result[type] ??= [])
            const existing = typeSlot.find((s) => s.entity.id === e.id)
            if (existing) { existing.quantity++ } else { typeSlot.push({ entity: e, quantity: 1 }) }
            if (c > 0) typeRemaining -= c
            added = true
          }
        }
        const spent = isFinite(typeBudget) ? typeBudget - typeRemaining : 0
        if (isFinite(spent)) fillBudget = Math.max(0, fillBudget - Math.max(0, spent - (floor[type] ?? 0)))

      } else {
        let typeRemaining = typeBudget

        for (const e of sorted) {
          if ((result[type] ?? []).some((s) => s.entity.id === e.id)) continue
          if (usedCapacity(type, result[type] ?? [], cfg) >= limit) break
          const c = unitCost(e, cfg)
          const capPerKit = capAttr ? Number(e.attributes[capAttr] ?? 1) : 1
          const remCap = remainingCapacity(type, result[type] ?? [], limit, cfg)
          const slotsLeft = capPerKit > 0 ? Math.floor(remCap / capPerKit) : remCap
          const maxQty = c > 0 ? Math.min(slotsLeft, Math.floor(typeRemaining / c)) : slotsLeft > 0 ? 1 : 0
          if (maxQty < 1) continue
          let qty = maxQty
          if (cfg.aggregateGuardTypes.includes(type) && !passesAggregateWithQty(result, type, e, qty, rules, cfg)) {
            qty = qty - 1
            while (qty > 0 && !passesAggregateWithQty(result, type, e, qty, rules, cfg)) qty--
            if (qty < 1) continue
          }
          ;(result[type] ??= []).push({ entity: e, quantity: qty })
          if (c > 0) typeRemaining -= c * qty
        }

        const spent = isFinite(typeBudget) ? typeBudget - typeRemaining : 0
        if (isFinite(spent)) fillBudget = Math.max(0, fillBudget - Math.max(0, spent - (floor[type] ?? 0)))
      }

    } else {
      let typeRemaining = typeBudget
      for (const e of sorted) {
        if ((result[type] ?? []).length >= limit) break
        if ((result[type] ?? []).some((s) => s.entity.id === e.id)) continue
        if (unitCost(e, cfg) > typeRemaining) continue
        if (cfg.aggregateGuardTypes.includes(type)) {
          if (!passesAggregateWithQty(result, type, e, 1, rules, cfg)) continue
        }
        ;(result[type] ??= []).push({ entity: e, quantity: 1 })
        typeRemaining -= unitCost(e, cfg)
      }
      const spent = isFinite(typeBudget) ? typeBudget - typeRemaining : 0
      if (isFinite(spent)) fillBudget = Math.max(0, fillBudget - Math.max(0, spent - (floor[type] ?? 0)))
    }
  }

  return { slots: result, overflow }
}

/**
 * Rule ความโลภแยกต่างหาก — upgrade pass
 *
 * หลัง repair loop: สำหรับแต่ละ type ใน upgradeOrder (เช่น gpu, cpu, mb)
 * พยายาม upgrade component ปัจจุบันโดย:
 *   1. ใช้งบที่เหลือโดยตรง
 *   2. ถ้าไม่พอ: ขาย RAM 1 kit (qty > 1 → ยังเหลืออย่างน้อย 1) แล้ว upgrade
 * ไม่แตะ pinned items — ทำงานกับ slots ที่ greedy fill ได้
 */
function upgradePass(
  slots: Record<string, SlotItem[]>,
  entities: Entity[],
  rules: CompatibilityRule[],
  cfg: DomainConfig,
  budget: number,
): Record<string, SlotItem[]> {
  if (!cfg.upgradeOrder?.length) return slots

  const result: Record<string, SlotItem[]> = Object.fromEntries(
    Object.entries(slots).map(([k, v]) => [k, [...v]]),
  )

  for (const upgradeType of cfg.upgradeOrder) {
    const current = (result[upgradeType] ?? [])[0]
    if (!current) continue

    const currentCost = unitCost(current.entity, cfg)
    const remaining = budget - totalCostOf(result, cfg)

    const filled = cfg.entityTypes.flatMap((t) =>
      t === upgradeType ? [] : (result[t] ?? []).map((s) => s.entity),
    )

    const candidates = entities
      .filter((e) => e.entity_type === upgradeType && e.status === 'published')
      .filter((e) => unitCost(e, cfg) > currentCost)
      .filter((e) => cachedPairwise(e, filled, rules))
      .sort((a, b) => unitCost(b, cfg) - unitCost(a, cfg))

    // 1. Direct upgrade with remaining budget
    const directUpgrade = candidates.find((e) => unitCost(e, cfg) - currentCost <= remaining)
    if (directUpgrade) {
      result[upgradeType] = [{ entity: directUpgrade, quantity: 1 }]
      continue
    }

    // 2. Trade 1 RAM kit for upgrade (RAM qty must stay ≥ 1)
    const ramItems = result['ram'] ?? []
    const totalRamQty = ramItems.reduce((s, i) => s + i.quantity, 0)
    if (totalRamQty > 1 && ramItems[0]) {
      const ramKitCost = unitCost(ramItems[0].entity, cfg)
      const tradeUpgrade = candidates.find(
        (e) => unitCost(e, cfg) - currentCost <= remaining + ramKitCost,
      )
      if (tradeUpgrade) {
        const firstRam = ramItems[0]
        result['ram'] =
          firstRam.quantity > 1
            ? [{ entity: firstRam.entity, quantity: firstRam.quantity - 1 }, ...ramItems.slice(1)]
            : ramItems.slice(1)
        result[upgradeType] = [{ entity: tradeUpgrade, quantity: 1 }]
      }
    }
  }

  return result
}

/**
 * สร้าง suggestion พร้อม repair loop
 *
 * ถ้า required type ขาด: block ชิ้นที่แพงที่สุดใน slot ที่ไม่ได้ pin
 * แล้ว fill ใหม่ วนจนกว่าจะครบ หรือไม่มีอะไรให้ block แล้ว
 * กรณีงบไม่พอจริงคืนชุดที่ขาดน้อยที่สุด
 */
export function buildSuggestion(
  entities: Entity[],
  rules: CompatibilityRule[],
  cfg: DomainConfig,
  input: SuggestInput,
): SuggestResult {
  const pinned = Object.fromEntries(
    cfg.entityTypes.map((t) => [t, input.pinned?.[t] ?? []]),
  ) as Record<string, SlotItem[]>
  const excluded = Object.fromEntries(
    cfg.entityTypes.map((t) => [t, input.excluded?.[t] ?? false]),
  ) as Record<string, boolean>
  const userBlocked = new Set(input.blockedIds ?? [])

  const repairBlocked = new Set<number>()
  const maxIter = cfg.maxRepairIterations ?? entities.length

  let attempt = greedyFill(entities, rules, cfg, {
    budget: input.budget, pinned, excluded, blockedIds: userBlocked,
  })

  const missingOf = (a: typeof attempt) =>
    cfg.requiredTypes.filter((t) => !excluded[t] && (a.slots[t] ?? []).length === 0)

  let best = attempt
  let bestMissing = missingOf(attempt).length
  let bestCost = totalCostOf(attempt.slots, cfg)
  let bestBlocked: number[] = []

  if (input.budget !== null) {
    for (let i = 0; i < maxIter; i++) {
      const missing = missingOf(attempt)
      if (missing.length === 0) break

      let victim: Entity | null = null
      let victimCost = -Infinity
      for (const t of cfg.fillOrder) {
        if ((pinned[t] ?? []).length > 0) continue
        if (missing.includes(t)) continue
        for (const s of (attempt.slots[t] ?? [])) {
          const c = slotCost(s, cfg)
          if (c > victimCost) { victimCost = c; victim = s.entity }
        }
      }
      if (!victim) break

      repairBlocked.add(victim.id)
      attempt = greedyFill(entities, rules, cfg, {
        budget: input.budget, pinned, excluded,
        blockedIds: new Set([...userBlocked, ...repairBlocked]),
      })

      const m = missingOf(attempt).length
      const c = totalCostOf(attempt.slots, cfg)
      if (m < bestMissing || (m === bestMissing && c > bestCost)) {
        best = attempt; bestMissing = m; bestCost = c; bestBlocked = [...repairBlocked]
      }
    }
  }

  const finalSlots =
    input.budget !== null && cfg.upgradeOrder?.length
      ? upgradePass(best.slots, entities, rules, cfg, input.budget)
      : best.slots

  return { slots: finalSlots, overflow: best.overflow, repairedBlockedIds: bestBlocked }
}

/**
 * Validate ชุด items กับ rules ทั้งหมด (pairwise + aggregate + required types)
 */
export function validateItems(
  items: SimulationItem[],
  rules: CompatibilityRule[],
  cfg: DomainConfig,
  constraints: Record<string, unknown> = {},
): ValidationIssue[] {
  const result: ValidationIssue[] = []

  const presentTypes = new Set(items.map((i) => i.entity.entity_type))
  for (const t of cfg.requiredTypes) {
    if (!presentTypes.has(t)) {
      result.push({
        rule_code:  `MISSING_${t.toUpperCase()}`,
        check_type: 'aggregate',
        severity:   'error',
        message:    `ไม่มี ${cfg.entityTypeLabels[t] ?? t} ใน configuration`,
        resolution: `เพิ่ม ${cfg.entityTypeLabels[t] ?? t} อย่างน้อย 1 รายการ`,
      })
    }
  }

  const activeRules = [...rules].filter((r) => r.is_active).sort((a, b) => b.priority - a.priority)
  const uniq = uniqueEntities(items.map((i) => i.entity))
  for (const rule of activeRules) {
    if (rule.check_type === 'pairwise') result.push(...runPairwise(rule, uniq))
    else result.push(...runAggregate(rule, items, constraints))
  }
  return result
}

export function aggregateDetailFor(
  items: SimulationItem[],
  rules: CompatibilityRule[],
  cfg: DomainConfig,
): { aggregate_value: number; capacity_value: number; utilization_pct: number } | null {
  const primaryRule = rules.find((r) => r.code === cfg.aggregateDisplay.primary && r.is_active)
  if (primaryRule) {
    const detail = getAggregateDetail(primaryRule, items, {})
    if (detail !== null) return detail
  }
  if (cfg.aggregateDisplay.safety) {
    const safetyRule = rules.find((r) => r.code === cfg.aggregateDisplay.safety && r.is_active)
    if (safetyRule) {
      const detail = getAggregateDetail(safetyRule, items, {})
      if (detail !== null) return detail
    }
  }
  return null
}

export function buildBom(
  slots: Record<string, SlotItem[]>,
  cfg: DomainConfig,
): BomItem[] {
  let line = 0
  return cfg.fillOrder.flatMap((t) =>
    (slots[t] ?? []).map((s) => {
      line += 10
      return {
        line_number: line,
        entity:      s.entity,
        quantity:    s.quantity,
        unit_cost:   unitCost(s.entity, cfg),
        total_cost:  slotCost(s, cfg),
      }
    }),
  )
}

export function totalCostOf(slots: Record<string, SlotItem[]>, cfg: DomainConfig): number {
  return cfg.entityTypes.reduce(
    (sum, t) => sum + (slots[t] ?? []).reduce((s, i) => s + slotCost(i, cfg), 0), 0,
  )
}

export { unitCost, slotCost, maxFor, usedCapacity, uniqueEntities, cachedPairwise }
