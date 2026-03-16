import type { Entity, SimulationItem, ValidationIssue, BomItem } from '~/data/types'
import { RULES } from '~/data/rules'
import { ENTITIES, ENTITY_TYPES, type EntityType } from '~/data/entities'
import { runPairwise } from '~/engine/pairwise'
import { runAggregate } from '~/engine/aggregate'

const FILL_ORDER: EntityType[] = ['gpu', 'cpu', 'motherboard', 'ram', 'psu']

export function useSimulation() {

  // ─── State ────────────────────────────────────────────────────
  const budget = ref<number | null>(null)

  // pinned: user ล็อกชิ้นส่วนนี้ไว้
  const pinned = reactive<Record<EntityType, Entity | null>>({
    motherboard: null, cpu: null, ram: null, gpu: null, psu: null,
  })

  // excluded: user เลือกว่าไม่ต้องการ slot นี้เลย
  // suggestion engine จะ skip slot ที่ excluded อยู่
  const excluded = reactive<Record<EntityType, boolean>>({
    motherboard: false, cpu: false, ram: false, gpu: false, psu: false,
  })

  // ─── Helpers ──────────────────────────────────────────────────

  function cost(e: Entity): number {
    return Number(e.attributes.unit_cost ?? 0)
  }

  function toItems(entities: Entity[]): SimulationItem[] {
    return entities.map((entity, idx) => ({ id: idx + 1, entity, quantity: 1 }))
  }

  function passesPairwise(candidate: Entity, others: Entity[]): boolean {
    const errorRules = RULES.filter(
      (r) => r.is_active && r.check_type === 'pairwise' && r.severity === 'error',
    )
    for (const rule of errorRules) {
      if (runPairwise(rule, [candidate, ...others]).length > 0) return false
    }
    return true
  }

  function passesAggregate(items: SimulationItem[]): boolean {
    const errorRules = RULES.filter(
      (r) => r.is_active && r.check_type === 'aggregate' && r.severity === 'error',
    )
    for (const rule of errorRules) {
      if (runAggregate(rule, items, {}).length > 0) return false
    }
    return true
  }

  // ─── Suggestion engine ────────────────────────────────────────

  const suggestion = computed((): Record<EntityType, Entity | null> => {
    const result = {} as Record<EntityType, Entity | null>

    for (const type of ENTITY_TYPES) {
      // excluded → null เสมอ ไม่ fill ให้
      result[type] = excluded[type] ? null : pinned[type]
    }

    const pinnedCost = ENTITY_TYPES
      .filter((t) => !excluded[t] && pinned[t])
      .reduce((sum, t) => sum + cost(pinned[t]!), 0)

    let remaining = budget.value !== null ? budget.value - pinnedCost : Infinity

    for (const type of FILL_ORDER) {
      if (excluded[type])          continue  // excluded → skip ทั้งหมด
      if (result[type] !== null)   continue  // pinned → skip

      const filled = ENTITY_TYPES
        .filter((t) => t !== type && result[t] !== null)
        .map((t) => result[t]!)

      const candidates = ENTITIES
        .filter((e) => {
          if (e.entity_type !== type) return false
          if (cost(e) > remaining) return false
          if (!passesPairwise(e, filled)) return false
          if (type === 'psu') {
            const testItems = toItems([...filled, e])
            if (!passesAggregate(testItems)) return false
          }
          return true
        })
        .sort((a, b) => cost(b) - cost(a))

      const best = candidates[0] ?? null
      result[type] = best
      if (best) remaining -= cost(best)
    }

    return result
  })

  // ─── Computed ─────────────────────────────────────────────────

  const selectedEntities = computed((): Entity[] =>
    ENTITY_TYPES.map((t) => suggestion.value[t]).filter((e): e is Entity => e !== null),
  )

  const simulationItems = computed((): SimulationItem[] =>
    toItems(selectedEntities.value),
  )

  const totalCost = computed(() =>
    selectedEntities.value.reduce((sum, e) => sum + cost(e), 0),
  )

  const budgetRemaining = computed(() =>
    budget.value !== null ? budget.value - totalCost.value : null,
  )

  const budgetUsedPct = computed(() =>
    budget.value ? Math.min((totalCost.value / budget.value) * 100, 100) : 0,
  )

  const issues = computed((): ValidationIssue[] => {
    if (selectedEntities.value.length < 2) return []
    const result: ValidationIssue[] = []
    const activeRules = RULES
      .filter((r) => r.is_active)
      .sort((a, b) => b.priority - a.priority)
    for (const rule of activeRules) {
      if (rule.check_type === 'pairwise')
        result.push(...runPairwise(rule, selectedEntities.value))
      else
        result.push(...runAggregate(rule, simulationItems.value, {}))
    }
    return result
  })

  const aggregateDetail = computed(() => {
    const powerRule = RULES.find((r) => r.code === 'AGG_POWER_CAPACITY' && r.is_active)
    if (!powerRule || simulationItems.value.length < 2) return null

    const powerIssues = runAggregate(powerRule, simulationItems.value, {})
    if (powerIssues.length > 0) return powerIssues[0].detail ?? null

    const safetyRule = RULES.find((r) => r.code === 'AGG_POWER_SAFETY' && r.is_active)
    if (safetyRule) {
      const safetyIssues = runAggregate(safetyRule, simulationItems.value, {})
      if (safetyIssues.length > 0) return safetyIssues[0].detail ?? null
    }

    return null
  })

  const isValid = computed(() =>
    selectedEntities.value.length > 0 &&
    issues.value.filter((i) => i.severity === 'error').length === 0,
  )

  const bom = computed((): BomItem[] => {
    if (!isValid.value) return []
    return selectedEntities.value.map((entity, idx) => ({
      line_number: (idx + 1) * 10,
      entity,
      quantity:   1,
      unit_cost:  cost(entity),
      total_cost: cost(entity),
    }))
  })

  // ─── Actions ──────────────────────────────────────────────────

  function pin(type: EntityType, entity: Entity | null): void {
    pinned[type]  = entity
    excluded[type] = false   // pin ใหม่ → ยกเลิก excluded อัตโนมัติ
  }

  function exclude(type: EntityType, value: boolean): void {
    excluded[type] = value
    if (value) pinned[type] = null  // excluded → ล้าง pin ด้วย
  }

  function clearAll(): void {
    budget.value = null
    ENTITY_TYPES.forEach((t) => {
      pinned[t]   = null
      excluded[t] = false
    })
  }

  return {
    budget,
    pinned,
    excluded,
    suggestion,
    selectedEntities,
    simulationItems,
    totalCost,
    budgetRemaining,
    budgetUsedPct,
    issues,
    aggregateDetail,
    isValid,
    bom,
    pin,
    exclude,
    clearAll,
  }
}
