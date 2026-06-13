import type { Entity, SimulationItem, ValidationIssue, BomItem } from '~/data/types'
import { RULES } from '~/data/rules'
import { ENTITIES, ENTITY_TYPES, ENTITY_TYPE_LABELS, type EntityType } from '~/data/entities'
import { runPairwise } from '~/engine/pairwise'
import { runAggregate, getAggregateDetail } from '~/engine/aggregate'
import { buildSuggestion } from '~/engine/suggest'
import { DEFAULT_DOMAIN_CONFIG } from '~/composables/domainConfig'
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
  REQUIRED_TYPES,
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

function emptySlots(): Record<EntityType, SlotItem[]> {
  return Object.fromEntries(ENTITY_TYPES.map((t) => [t, [] as SlotItem[]])) as Record<EntityType, SlotItem[]>
}

function maxFor(type: EntityType, slots?: Record<EntityType, SlotItem[]>): number {
  if (MAX_PER_TYPE[type] !== undefined) return MAX_PER_TYPE[type]!
  const dynCfg = DYNAMIC_MAX_PER_TYPE[type]
  if (dynCfg && slots) {
    const sourceItems = slots[dynCfg.source_type]
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

function usedCapacity(type: EntityType, items: { entity: Entity; quantity: number }[]): number {
  const dynCfg = DYNAMIC_MAX_PER_TYPE[type]
  if (!dynCfg?.capacity_attribute) return items.reduce((sum, s) => sum + s.quantity, 0)
  const attr = dynCfg.capacity_attribute
  return items.reduce((sum, s) => sum + Number(s.entity.attributes[attr] ?? 1) * s.quantity, 0)
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

export function useSimulation() {

  const budget = ref<number | null>(null)
  const pinned = reactive<Record<EntityType, SlotItem[]>>(emptySlots())
  const excluded = reactive<Record<EntityType, boolean>>(
    Object.fromEntries(ENTITY_TYPES.map((t) => [t, false])) as Record<EntityType, boolean>,
  )
  const blockedIds = reactive<Set<number>>(new Set())

  const _suggestionData = computed((): { slots: Record<EntityType, SlotItem[]>; overflow: boolean } => {
    const result = buildSuggestion(ENTITIES, RULES, DEFAULT_DOMAIN_CONFIG, {
      budget:     budget.value,
      pinned:     Object.fromEntries(ENTITY_TYPES.map((t) => [t, pinned[t]])),
      excluded:   Object.fromEntries(ENTITY_TYPES.map((t) => [t, excluded[t]])),
      blockedIds: blockedIds,
    })
    return {
      slots:    result.slots as Record<EntityType, SlotItem[]>,
      overflow: result.overflow,
    }
  })

  const suggestion = computed(() => _suggestionData.value.slots)
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

    for (const t of REQUIRED_TYPES) {
      if (suggestion.value[t].length === 0) {
        result.push({
          rule_code:  `MISSING_${t.toUpperCase()}`,
          check_type: 'aggregate',
          severity:   'error',
          message:    `ไม่มี ${ENTITY_TYPE_LABELS[t]} ที่เหมาะสม — อาจเกิดจากงบไม่พอหรือ compatibility ขัดกัน`,
          resolution: 'ตรวจสอบงบประมาณหรือปลด pin ชิ้นส่วนอื่น',
        })
      }
    }

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
