// ══════════════════════════════════════════════════════════════════
//  ENGINE — ห้ามแก้
//  config อยู่ที่ simulationConfig.ts
// ══════════════════════════════════════════════════════════════════

import type { Entity, SimulationItem, ValidationIssue, BomItem } from '~/data/types'
import { RULES } from '~/data/rules'
import { ENTITIES, ENTITY_TYPES, type EntityType } from '~/data/entities'
import { runPairwise } from '~/engine/pairwise'
import { runAggregate, getAggregateDetail } from '~/engine/aggregate'
import {
  FILL_ORDER,
  MAX_PER_TYPE,
  QUANTITY_MODE,
  SELECTION_STRATEGY,
  BUDGET_FLOOR_PER_TYPE,
  HARD_FLOOR_MIN,
  STACK_DISTRIBUTE_MODE,
  DYNAMIC_MAX_PER_TYPE,
  QUANTITY_MODE_PER_TYPE,
  AGGREGATE_GUARD_TYPES,
  AGGREGATE_DISPLAY,
  COST_ATTRIBUTE,
  COST_PRECISION,
} from '~/composables/simulationConfig'

export interface SlotItem {
  entity: Entity
  quantity: number
}

function unitCost(e: Entity): number {
  const raw = e.attributes[COST_ATTRIBUTE] ?? 0
  return parseFloat(Number(raw).toFixed(COST_PRECISION))
}

function slotCost(s: SlotItem): number {
  return unitCost(s.entity) * s.quantity
}

function toSimItems(slots: Record<EntityType, SlotItem[]>): SimulationItem[] {
  let id = 0
  return ENTITY_TYPES.flatMap((t) =>
    slots[t].map((s) => ({ id: ++id, entity: s.entity, quantity: s.quantity })),
  )
}

function sortCandidates(candidates: Entity[], remaining: number): Entity[] {
  const copy = [...candidates]
  switch (SELECTION_STRATEGY) {
    case 'lowest_cost':
      return copy.sort((a, b) => unitCost(a) - unitCost(b))
    case 'best_fit':
      return copy.sort(
        (a, b) => Math.abs(unitCost(a) - remaining) - Math.abs(unitCost(b) - remaining),
      )
    default:
      return copy.sort((a, b) => unitCost(b) - unitCost(a))
  }
}

function emptySlots(): Record<EntityType, SlotItem[]> {
  return Object.fromEntries(ENTITY_TYPES.map((t) => [t, []])) as Record<EntityType, SlotItem[]>
}

function maxFor(type: EntityType, slots?: Record<EntityType, SlotItem[]>): number {
  if (MAX_PER_TYPE[type] !== undefined) return MAX_PER_TYPE[type]!
  const dynCfg = DYNAMIC_MAX_PER_TYPE[type]
  if (dynCfg && slots) {
    const sourceItems = slots[dynCfg.source_type]
    if (sourceItems.length > 0) {
      const val = sourceItems[0].entity.attributes[dynCfg.source_attribute]
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

function usedCapacity(type: EntityType, items: { entity: Entity; quantity: number }[]): number {
  const dynCfg = DYNAMIC_MAX_PER_TYPE[type]
  if (!dynCfg?.capacity_attribute) return items.length
  const attr = dynCfg.capacity_attribute
  return items.reduce((sum, s) => sum + Number(s.entity.attributes[attr] ?? 1) * s.quantity, 0)
}

function remainingCapacity(type: EntityType, items: { entity: Entity; quantity: number }[], limit: number): number {
  return limit - usedCapacity(type, items)
}

interface FloorResult {
  floor: Record<EntityType, number>
  overflow: boolean
}

function computeFloor(totalBudget: number, freeTypes: EntityType[]): FloorResult {
  const raw = Object.fromEntries(
    freeTypes.map((t) => [t, totalBudget * (BUDGET_FLOOR_PER_TYPE[t] ?? 0)]),
  ) as Record<EntityType, number>

  const totalHardMin = freeTypes.reduce((s, t) => s + (HARD_FLOOR_MIN[t] ?? 0), 0)
  const overflow = totalHardMin > totalBudget

  const total = freeTypes.reduce((s, t) => s + raw[t], 0)
  let floor: Record<EntityType, number>

  if (total > totalBudget && total > 0) {
    const scale = totalBudget / total
    floor = Object.fromEntries(
      freeTypes.map((t) => {
        const hardMin = HARD_FLOOR_MIN[t] ?? 0
        const scaled = raw[t] * scale
        return [t, Math.min(totalBudget, Math.max(hardMin, scaled))]
      }),
    ) as Record<EntityType, number>
  } else {
    floor = Object.fromEntries(
      freeTypes.map((t) => [t, Math.max(raw[t], HARD_FLOOR_MIN[t] ?? 0)]),
    ) as Record<EntityType, number>
  }

  return { floor, overflow }
}

const _pwCache = new Map<string, boolean>()

if (import.meta.hot) {
  import.meta.hot.accept(() => { _pwCache.clear() })
}

function cachedPairwise(candidate: Entity, others: Entity[]): boolean {
  const errorRules = RULES.filter(
    (r) => r.is_active && r.check_type === 'pairwise' && r.severity === 'error',
  )
  const uniqueOthers = uniqueEntities(others)

  for (const rule of errorRules) {
    for (const other of uniqueOthers) {
      const key = `${rule.id}:${candidate.id}:${other.id}`
      if (!_pwCache.has(key)) {
        _pwCache.set(key, runPairwise(rule, [candidate, other]).length === 0)
        const keyRev = `${rule.id}:${other.id}:${candidate.id}`
        if (!_pwCache.has(keyRev)) {
          _pwCache.set(keyRev, runPairwise(rule, [other, candidate]).length === 0)
        }
      }
      if (!_pwCache.get(key)) return false
    }
  }
  return true
}

// ══════════════════════════════════════════════════════════════════

export function useSimulation() {

  const budget = ref<number | null>(null)
  const pinned = reactive<Record<EntityType, SlotItem[]>>(emptySlots())
  const excluded = reactive<Record<EntityType, boolean>>(
    Object.fromEntries(ENTITY_TYPES.map((t) => [t, false])) as Record<EntityType, boolean>,
  )
  const blockedIds = reactive<Set<number>>(new Set())

  function passesAggregate(items: SimulationItem[]): boolean {
    return RULES.filter(
      (r) => r.is_active && r.check_type === 'aggregate' && r.severity === 'error',
    ).every((rule) => runAggregate(rule, items, {}).length === 0)
  }

  function passesAggregateWithQty(
    result: Record<EntityType, SlotItem[]>,
    type: EntityType,
    entity: Entity,
    qty: number,
  ): boolean {
    const testSlots = {
      ...result,
      [type]: [...result[type], { entity, quantity: qty }],
    }
    return passesAggregate(toSimItems(testSlots))
  }

  // BUG-A fix: แยก computed ที่คำนวณทั้ง slots และ overflow ออกมา
  // เพื่อกำจัด side effect (floorOverflow.value = overflow) ใน computed เดิม
  const _suggestionData = computed((): { slots: Record<EntityType, SlotItem[]>; overflow: boolean } => {
    const result = emptySlots()

    for (const type of ENTITY_TYPES) {
      result[type] = excluded[type] ? [] : pinned[type].map((s) => ({ ...s }))
    }

    const pinnedCost = ENTITY_TYPES
      .filter((t) => !excluded[t])
      .reduce((sum, t) => sum + result[t].reduce((s, i) => s + slotCost(i), 0), 0)

    let remaining = budget.value !== null ? budget.value - pinnedCost : Infinity
    const freeTypes = FILL_ORDER.filter((t) => !excluded[t] && result[t].length === 0)

    const { floor, overflow } = budget.value !== null
      ? computeFloor(remaining, freeTypes)
      : {
        floor: Object.fromEntries(ENTITY_TYPES.map((t) => [t, 0])) as Record<EntityType, number>,
        overflow: false,
      }

    const totalFloor = freeTypes.reduce((s, t) => s + floor[t], 0)
    let fillBudget = Math.max(0, remaining - totalFloor)

    for (const type of FILL_ORDER) {
      if (excluded[type]) continue
      if (pinned[type].length > 0) continue
      const limit = maxFor(type, result)
      if (usedCapacity(type, result[type]) >= limit) continue

      const filled = ENTITY_TYPES.flatMap((t) => result[t].map((s) => s.entity))
      const typeBudget = fillBudget + floor[type]

      const filtered = ENTITIES.filter((e) => {
        if (e.status !== 'published') return false
        if (e.entity_type !== type) return false
        if (unitCost(e) > typeBudget) return false
        if (blockedIds.has(e.id) && !pinned[type].some((s) => s.entity.id === e.id)) return false
        if (!cachedPairwise(e, filled)) return false
        if (AGGREGATE_GUARD_TYPES.includes(type)) {
          if (!passesAggregateWithQty(result, type, e, 1)) return false
        }
        return true
      })

      const sorted = sortCandidates(filtered, typeBudget)
      const effectiveMode = QUANTITY_MODE_PER_TYPE[type] ?? QUANTITY_MODE

      if (effectiveMode === 'stack') {
        if (STACK_DISTRIBUTE_MODE === 'round_robin') {
          let typeRemaining = typeBudget
          let added = true
          while (added && usedCapacity(type, result[type]) < limit && typeRemaining >= 0) {
            added = false
            for (const e of sorted) {
              if (usedCapacity(type, result[type]) >= limit) break
              const c = unitCost(e)
              if (c > 0 && c > typeRemaining) continue
              if (AGGREGATE_GUARD_TYPES.includes(type)) {
                if (!passesAggregateWithQty(result, type, e, 1)) continue
              }
              const existing = result[type].find((s) => s.entity.id === e.id)
              if (existing) { existing.quantity++ } else { result[type].push({ entity: e, quantity: 1 }) }
              if (c > 0) typeRemaining -= c
              added = true
            }
          }
          const spent = isFinite(typeBudget)
            ? typeBudget - typeRemaining
            : typeRemaining === typeBudget ? 0 : typeBudget - typeRemaining
          if (isFinite(spent)) fillBudget = Math.max(0, fillBudget - Math.max(0, spent - floor[type]))

        } else {
          let typeRemaining = typeBudget
          const dynCapCfg = DYNAMIC_MAX_PER_TYPE[type]
          const capAttr = dynCapCfg?.capacity_attribute

          for (const e of sorted) {
            if (result[type].some((s) => s.entity.id === e.id)) continue
            if (usedCapacity(type, result[type]) >= limit) break
            const c = unitCost(e)
            const capPerKit = capAttr ? Number(e.attributes[capAttr] ?? 1) : 1
            const rem_cap = remainingCapacity(type, result[type], limit)
            const slotsLeft = capPerKit > 0 ? Math.floor(rem_cap / capPerKit) : rem_cap
            const maxQty = c > 0 ? Math.min(slotsLeft, Math.floor(typeRemaining / c)) : slotsLeft > 0 ? 1 : 0
            if (maxQty < 1) continue
            let qty = maxQty
            if (AGGREGATE_GUARD_TYPES.includes(type) && !passesAggregateWithQty(result, type, e, qty)) {
              qty = qty - 1
              while (qty > 0 && !passesAggregateWithQty(result, type, e, qty)) qty--
              if (qty < 1) continue
            }
            result[type].push({ entity: e, quantity: qty })
            if (c > 0) typeRemaining -= c * qty
          }

          const spent = isFinite(typeBudget) ? typeBudget - typeRemaining : 0
          if (isFinite(spent)) fillBudget = Math.max(0, fillBudget - Math.max(0, spent - floor[type]))
        }

      } else {
        let typeRemaining = typeBudget
        for (const e of sorted) {
          if (result[type].length >= limit) break
          if (result[type].some((s) => s.entity.id === e.id)) continue
          if (unitCost(e) > typeRemaining) continue
          if (AGGREGATE_GUARD_TYPES.includes(type)) {
            if (!passesAggregateWithQty(result, type, e, 1)) continue
          }
          result[type].push({ entity: e, quantity: 1 })
          typeRemaining -= unitCost(e)
        }
        const spent = isFinite(typeBudget) ? typeBudget - typeRemaining : 0
        if (isFinite(spent)) fillBudget = Math.max(0, fillBudget - Math.max(0, spent - floor[type]))
      }
    }

    return { slots: result, overflow }
  })

  const suggestion = computed(() => _suggestionData.value.slots)
  // BUG-A fix: floorOverflow เป็น computed แทน ref — ไม่มี side effect
  const floorOverflow = computed(() => _suggestionData.value.overflow)

  const simulationItems = computed((): SimulationItem[] => toSimItems(suggestion.value))
  const selectedEntities = computed((): Entity[] => simulationItems.value.map((i) => i.entity))

  const totalCost = computed(() =>
    ENTITY_TYPES.reduce((sum, t) => sum + suggestion.value[t].reduce((s, i) => s + slotCost(i), 0), 0),
  )

  const budgetRemaining = computed(() =>
    budget.value !== null ? budget.value - totalCost.value : null,
  )

  const budgetUsedPct = computed(() =>
    budget.value ? (totalCost.value / budget.value) * 100 : 0,
  )

  const issues = computed((): ValidationIssue[] => {
    if (simulationItems.value.length < 2) return []
    const result: ValidationIssue[] = []
    const activeRules = RULES.filter((r) => r.is_active).sort((a, b) => b.priority - a.priority)
    const uniq = uniqueEntities(selectedEntities.value)
    for (const rule of activeRules) {
      if (rule.check_type === 'pairwise')
        result.push(...runPairwise(rule, uniq))
      else
        result.push(...runAggregate(rule, simulationItems.value, {}))
    }
    return result
  })

  const aggregateDetail = computed(() => {
    if (simulationItems.value.length < 2) return null
    const primaryRule = RULES.find((r) => r.code === AGGREGATE_DISPLAY.primary && r.is_active)
    if (primaryRule) {
      const detail = getAggregateDetail(primaryRule, simulationItems.value, {})
      if (detail !== null) return detail
    }
    if (AGGREGATE_DISPLAY.safety) {
      const safetyRule = RULES.find((r) => r.code === AGGREGATE_DISPLAY.safety && r.is_active)
      if (safetyRule) {
        const detail = getAggregateDetail(safetyRule, simulationItems.value, {})
        if (detail !== null) return detail
      }
    }
    return null
  })

  // BUG-B fix: ต้องมีอย่างน้อย 2 ชิ้นส่วน — ให้ตรงกับ threshold ของ issues computed
  // กรณี 1 ชิ้น: issues คืน [] เพราะ skip validation → isValid เคย = true ผิดพลาด
  const isValid = computed(() =>
    simulationItems.value.length >= 2 &&
    issues.value.filter((i) => i.severity === 'error').length === 0,
  )

  const bom = computed((): BomItem[] => {
    if (!isValid.value) return []
    let line = 0
    return FILL_ORDER.flatMap((t) =>
      suggestion.value[t].map((s) => {
        line += 10
        return { line_number: line, entity: s.entity, quantity: s.quantity, unit_cost: unitCost(s.entity), total_cost: slotCost(s) }
      }),
    )
  })

  function compatibleEntitiesFor(type: EntityType): Entity[] {
    const currentEntities = uniqueEntities(
      ENTITY_TYPES
        .filter((t) => t !== type && !excluded[t])
        .flatMap((t) => (pinned[t].length > 0 ? pinned[t] : suggestion.value[t]).map((s) => s.entity)),
    )
    return ENTITIES.filter((e) => {
      if (e.status !== 'published') return false
      if (e.entity_type !== type) return false
      // BUG-C fix: กรอง blocked entities ออกจาก picker ด้วย
      if (blockedIds.has(e.id)) return false
      return cachedPairwise(e, currentEntities)
    })
  }

  function slotLimit(type: EntityType): number {
    return maxFor(type, suggestion.value)
  }

  function canAddToSlot(type: EntityType, entity: Entity): boolean {
    const dynCfg = DYNAMIC_MAX_PER_TYPE[type]
    if (!dynCfg) {
      const staticLimit = MAX_PER_TYPE[type]
      if (staticLimit === undefined) return true
      return pinned[type].length < staticLimit
    }

    const srcSlot = suggestion.value[dynCfg.source_type][0] ?? null

    if (!srcSlot) return false

    const capacity = Number(srcSlot.entity.attributes[dynCfg.source_attribute] ?? 0)
    if (!capacity) return false

    const capAttr = dynCfg.capacity_attribute ?? 'modules'
    const usedModules = pinned[type].reduce((sum, s) => {
      const mod = Number(s.entity.attributes[capAttr] ?? 1)
      return sum + mod * s.quantity
    }, 0)
    const newModules = Number(entity.attributes[capAttr] ?? 1)

    return usedModules + newModules <= capacity
  }

  function pin(type: EntityType, entity: Entity | null): void {
    pinned[type] = entity ? [{ entity, quantity: 1 }] : []
    excluded[type] = false
  }

  function pinItems(type: EntityType, items: SlotItem[]): void {
    pinned[type] = items
    excluded[type] = false
  }

  function setPinnedQuantity(type: EntityType, index: number, quantity: number): void {
    if (pinned[type][index]) {
      pinned[type][index] = { ...pinned[type][index], quantity: Math.max(1, quantity) }
    }
  }

  function exclude(type: EntityType, value: boolean): void {
    excluded[type] = value
    if (value) pinned[type] = []
  }

  function blockEntity(entityId: number): void { blockedIds.add(entityId) }
  function unblockEntity(entityId: number): void { blockedIds.delete(entityId) }

  function clearAll(): void {
    budget.value = null
    ENTITY_TYPES.forEach((t) => { pinned[t] = []; excluded[t] = false })
    blockedIds.clear()
  }

  return {
    budget, pinned, slotCost, excluded, blockedIds, floorOverflow,
    suggestion, selectedEntities, simulationItems,
    totalCost, budgetRemaining, budgetUsedPct,
    issues, aggregateDetail, isValid, bom,
    slotLimit,
    canAddToSlot,
    pin, pinItems, setPinnedQuantity,
    exclude, blockEntity, unblockEntity, clearAll,
    compatibleEntitiesFor,
  }
}
