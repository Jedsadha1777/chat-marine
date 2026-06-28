import type { Entity, ValidationIssue, BomItem } from '~/data/types'
import { DOMAIN, ENTITY_TYPES, COST_ATTRIBUTE, COST_PRECISION, type EntityType } from '~/domains'
import type { SlotItem, DynamicMaxCfg } from '~/engine/suggest'
import { evalExpr } from '~/engine/ruleflow/eval'
import { parseExpr } from '~/engine/ruleflow/parser'
import type { AstNode } from '~/engine/ruleflow/types'

export type { SlotItem }

const _astCache = new Map<string, AstNode>()
function getAst(formula: string): AstNode {
  let ast = _astCache.get(formula)
  if (!ast) { ast = parseExpr(formula); _astCache.set(formula, ast) }
  return ast
}

function unitCost(e: Entity): number {
  const raw = e.attributes[COST_ATTRIBUTE] ?? 0
  return parseFloat(Number(raw).toFixed(COST_PRECISION))
}

function slotCost(s: SlotItem): number {
  return unitCost(s.entity) * s.quantity
}

function emptySlots(): Record<EntityType, SlotItem[]> {
  return Object.fromEntries(ENTITY_TYPES.map((t) => [t, [] as SlotItem[]])) as Record<EntityType, SlotItem[]>
}

export function useSimulation() {

  const budget = ref<number | null>(null)
  const pinned = reactive<Record<EntityType, SlotItem[]>>(emptySlots())
  const excluded = reactive<Record<EntityType, boolean>>(
    Object.fromEntries(ENTITY_TYPES.map((t) => [t, false])) as Record<EntityType, boolean>,
  )
  const blockedIds = reactive<Set<number>>(new Set())

  const requestBody = computed(() => ({
    budget: budget.value,
    pinned: Object.fromEntries(
      ENTITY_TYPES.map((t) => [
        t,
        pinned[t].map((s) => ({ id: s.entity.id, quantity: s.quantity })),
      ]),
    ),
    excluded: Object.fromEntries(ENTITY_TYPES.map((t) => [t, excluded[t]])),
    blockedIds: [...blockedIds],
  }))

  // No client-side engine or cache — server re-runs both on every call.
  const { data: _apiData, refresh: _refresh } = useAsyncData(
    'suggestion',
    () => $fetch('/api/suggest', { method: 'POST', body: requestBody.value }),
  )

  let _debounce: ReturnType<typeof setTimeout> | null = null
  watch(requestBody, () => {
    if (_debounce) clearTimeout(_debounce)
    _debounce = setTimeout(() => _refresh(), 400)
  }, { deep: true })

  const suggestion = computed((): Record<EntityType, SlotItem[]> => {
    const slots = (_apiData.value as { slots?: Record<string, SlotItem[]> })?.slots
    if (!slots) return emptySlots()
    return Object.fromEntries(
      ENTITY_TYPES.map((t) => [t, (slots[t] ?? []) as SlotItem[]]),
    ) as Record<EntityType, SlotItem[]>
  })

  const issues        = computed((): ValidationIssue[] => (_apiData.value as { issues?: ValidationIssue[] })?.issues ?? [])
  const isValid       = computed((): boolean => (_apiData.value as { isValid?: boolean })?.isValid ?? false)
  const bom           = computed((): BomItem[]  => (_apiData.value as { bom?: BomItem[] })?.bom ?? [])
  const totalCost     = computed((): number => (_apiData.value as { totalCost?: number })?.totalCost ?? 0)
  const aggregateDetail = computed(() => (_apiData.value as { aggregateDetail?: unknown })?.aggregateDetail ?? null)
  const floorOverflow = computed((): boolean => false)

  const budgetRemaining = computed(() =>
    budget.value !== null ? budget.value - totalCost.value : null,
  )
  const budgetUsedPct = computed(() =>
    budget.value ? (totalCost.value / budget.value) * 100 : 0,
  )

  // Only pinned items constrain the picker — auto-suggested items don't block switching.
  async function compatibleEntitiesFor(type: EntityType): Promise<Entity[]> {
    const currentEntityIds = ENTITY_TYPES
      .filter((t) => t !== type && !excluded[t])
      .flatMap((t) => pinned[t].map((s) => s.entity.id))
      .filter((id) => id != null)

    return $fetch<Entity[]>('/api/compatible', {
      method: 'POST',
      body: {
        type,
        currentEntityIds: [...new Set(currentEntityIds)],
        blockedIds:       [...blockedIds],
      },
    })
  }

  function dynFormulaCtx(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {}
    for (const [type, items] of Object.entries(suggestion.value)) {
      const entity = (items as SlotItem[])?.[0]?.entity
      if (entity) for (const [k, v] of Object.entries(entity.attributes)) ctx[`${type}_${k}`] = v
    }
    return ctx
  }

  function resolveDynCapacity(dynCfg: DynamicMaxCfg): number {
    if ('formula' in dynCfg) {
      try { return Number(evalExpr(getAst(dynCfg.formula), dynFormulaCtx())) || dynCfg.fallback }
      catch { return dynCfg.fallback }
    }
    const vals = dynCfg.sources
      .map(s => suggestion.value[s.source_type]?.[0]?.entity.attributes[s.source_attribute])
      .filter(v => v !== undefined && v !== null)
      .map(Number)
    if (!vals.length) return dynCfg.fallback
    if (dynCfg.aggregate === 'min') return Math.min(...vals)
    if (dynCfg.aggregate === 'max') return Math.max(...vals)
    return vals.reduce((a, b) => a + b, 0)
  }

  function slotLimit(type: EntityType): number {
    const dynCfg = DOMAIN.dynamicMaxPerType[type]
    if (!dynCfg) return DOMAIN.maxPerType[type] ?? 1
    return resolveDynCapacity(dynCfg)
  }

  function canAddToSlot(type: EntityType, entity: Entity): boolean {
    const dynCfg = DOMAIN.dynamicMaxPerType[type]
    if (!dynCfg) return pinned[type].length < slotLimit(type)

    const capacity = resolveDynCapacity(dynCfg)
    if (!capacity) return false

    const capAttr = dynCfg.capacity_attribute
    if (!capAttr || !entity.attributes[capAttr]) {
      const used = pinned[type].reduce((sum, s) => sum + s.quantity, 0)
      return used + 1 <= capacity
    }
    const usedCap = pinned[type].reduce((sum, s) => {
      return sum + Number(s.entity.attributes[capAttr] ?? 1) * s.quantity
    }, 0)
    return usedCap + Number(entity.attributes[capAttr] ?? 1) <= capacity
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
    suggestion, totalCost, budgetRemaining, budgetUsedPct,
    issues, aggregateDetail, isValid, bom,
    slotLimit, canAddToSlot,
    pin, pinItems, setPinnedQuantity,
    exclude, blockEntity, unblockEntity, clearAll,
    compatibleEntitiesFor,
  }
}
