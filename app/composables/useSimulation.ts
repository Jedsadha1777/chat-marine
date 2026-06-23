import type { Entity, ValidationIssue, BomItem } from '~/data/types'
import { ENTITY_TYPES, COST_ATTRIBUTE, COST_PRECISION, type EntityType } from '~/domains'
import type { SlotItem } from '~/engine/suggest'

export type { SlotItem }

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
        budget:           budget.value,
        currentEntityIds: [...new Set(currentEntityIds)],
        blockedIds:       [...blockedIds],
      },
    })
  }

  function slotLimit(type: EntityType): number {
    if (type !== 'ram') return 1
    const srcItems = suggestion.value['motherboard']
    if (srcItems.length > 0) {
      const val = srcItems[0]?.entity.attributes['ram_slots']
      if (val !== undefined && val !== null) return Number(val)
    }
    return 2
  }

  function canAddToSlot(type: EntityType, entity: Entity): boolean {
    const limit = slotLimit(type)
    if (type !== 'ram') return pinned[type].length < limit

    const srcItems = suggestion.value['motherboard']
    if (!srcItems?.length) return false
    const capacity = Number(srcItems[0]?.entity.attributes['ram_slots'] ?? 0)
    if (!capacity) return false

    if (!entity.attributes['modules']) {
      const used = pinned[type].reduce((sum, s) => sum + s.quantity, 0)
      return used + 1 <= capacity
    }
    const capAttr = 'modules'
    const usedModules = pinned[type].reduce((sum, s) => {
      return sum + Number(s.entity.attributes[capAttr] ?? 1) * s.quantity
    }, 0)
    return usedModules + Number(entity.attributes[capAttr] ?? 1) <= capacity
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
