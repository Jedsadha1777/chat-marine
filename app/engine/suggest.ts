import type {
  Entity,
  CompatibilityRule,
  SimulationItem,
  ValidationIssue,
  BomItem,
} from '~/data/types'
import { runPairwise, evalLogic } from '~/engine/pairwise'
import { runAggregate, getAggregateDetail } from '~/engine/aggregate'
import { getTierConditions, type TierRule } from '~/composables/tierRules'

export interface DynamicMaxCfg {
  source_type: string
  source_attribute: string
  capacity_attribute?: string
  fallback: number
}

export interface PostFillCfg {
  type: string
  preferAttribute?: string
}

export interface DomainConfig {
  fillOrder: string[]
  entityTypes: string[]
  entityTypeLabels: Record<string, string>
  maxPerType: Partial<Record<string, number>>
  dynamicMaxPerType: Partial<Record<string, DynamicMaxCfg>>
  aggregateGuardTypes: string[]
  aggregateDisplay: { primary: string; safety: string | null }
  requiredTypes: string[]
  costAttribute: string
  costPrecision: number
  tierRules?: TierRule[]
  // The type iterated first (highest-cost anchor). Defaults to fillOrder[0].
  anchorType?: string
  // Priority order for remaining types after anchor. Defaults to fillOrder minus anchorType.
  selectionOrder?: string[]
  // The type selected cheapest-adequate (capacity container). Defaults to last in fillOrder.
  capacityType?: string
  // Attribute on the capacity entity checked against total load. Defaults to 'watt_output'.
  capacityAttribute?: string
  // Attributes summed to compute load per entity (first non-null wins per entity). Defaults to ['power_draw_w', 'tdp_w'].
  loadAttributes?: string[]
  // Total load must not exceed this fraction of capacity attribute value. Defaults to 0.8.
  capacityFactor?: number
  // Types filled after main package using remaining budget, sorted by preferAttribute DESC.
  postFillTypes?: PostFillCfg[]
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
}

export function unitCost(e: Entity, cfg: DomainConfig): number {
  const raw = e.attributes[cfg.costAttribute] ?? 0
  return parseFloat(Number(raw).toFixed(cfg.costPrecision))
}

export function slotCost(s: SlotItem, cfg: DomainConfig): number {
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

export function maxFor(type: string, cfg: DomainConfig, slots?: Record<string, SlotItem[]>): number {
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

export function usedCapacity(type: string, items: SlotItem[], cfg: DomainConfig): number {
  const dynCfg = cfg.dynamicMaxPerType[type]
  if (!dynCfg?.capacity_attribute) {
    return items.reduce((sum, s) => sum + s.quantity, 0)
  }
  const attr = dynCfg.capacity_attribute
  return items.reduce((sum, s) => sum + Number(s.entity.attributes[attr] ?? 1) * s.quantity, 0)
}

export function uniqueEntities(entities: Entity[]): Entity[] {
  const seen = new Set<number>()
  return entities.filter((e) => { if (seen.has(e.id)) return false; seen.add(e.id); return true })
}

const _pwCacheByRules = new WeakMap<CompatibilityRule[], Map<string, boolean>>()

export function cachedPairwise(candidate: Entity, others: Entity[], rules: CompatibilityRule[]): boolean {
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

// ── Engine helpers ────────────────────────────────────────────────────────────

function findCheapestCapacity(
  available: Entity[],
  minCapacity: number,
  maxCost: number,
  cfg: DomainConfig,
): Entity | null {
  const capType: string = cfg.capacityType ?? cfg.fillOrder[cfg.fillOrder.length - 1]!
  const capAttr = cfg.capacityAttribute ?? 'watt_output'
  return available
    .filter((e) =>
      e.entity_type === capType &&
      Number(e.attributes[capAttr] ?? 0) >= minCapacity &&
      unitCost(e, cfg) <= maxCost
    )
    .sort((a, b) => unitCost(a, cfg) - unitCost(b, cfg))[0] ?? null
}

function entityLoad(e: Entity, cfg: DomainConfig): number {
  const attrs = cfg.loadAttributes ?? ['power_draw_w', 'tdp_w']
  const val = attrs.map((a) => e.attributes[a]).find((v) => v !== null && v !== undefined) ?? 0
  return Number(val)
}

function totalLoadOf(entities: Entity[], cfg: DomainConfig): number {
  return entities.reduce((sum, e) => sum + entityLoad(e, cfg), 0)
}

// Generic recursive backtracking fill.
// Iterates selectionOrder types in priority sequence, trying highest-cost candidates first.
// capacityType uses cheapest-adequate selection instead of best-first.
// Returns chosen entity map or null if no valid combination fits within budget.
function backtrackFill(
  selectionOrder: string[],
  index: number,
  chosen: Record<string, Entity>,
  remainingBudget: number,
  context: Entity[],
  anchorCtx: Entity[],
  tierCondsPerType: Record<string, Array<Record<string, unknown>>>,
  available: Entity[],
  rules: CompatibilityRule[],
  cfg: DomainConfig,
  toFill: Set<string>,
  capacityFactor: number,
  capacityType: string,
): Record<string, Entity> | null {
  if (index === selectionOrder.length) return chosen

  const type: string = selectionOrder[index]!
  const recurse = (next: Record<string, Entity>, budget: number) =>
    backtrackFill(selectionOrder, index + 1, next, budget, context, anchorCtx, tierCondsPerType, available, rules, cfg, toFill, capacityFactor, capacityType)

  if (!toFill.has(type)) return recurse(chosen, remainingBudget)

  // Capacity type: cheapest that meets the aggregate load requirement
  if (type === capacityType) {
    const loadItems = [...context, ...anchorCtx, ...Object.values(chosen)]
      .filter((e, i, arr) => arr.indexOf(e) === i && e.entity_type !== capacityType)
    const cap = findCheapestCapacity(available, totalLoadOf(loadItems, cfg) / capacityFactor, remainingBudget, cfg)
    if (!cap) return null
    return { ...chosen, [type]: cap }
  }

  // Regular component: pairwise compatibility + soft tier preference (tier-satisfying first, desc cost).
  const allCtx = [...context, ...anchorCtx, ...Object.values(chosen)]
  const tierConds: Array<Record<string, unknown>> = tierCondsPerType[type] ?? []
  const pairwiseOk = available.filter((e) =>
    e.entity_type === type && cachedPairwise(e, allCtx, rules)
  )
  const satisfiesTier = (e: Entity): boolean =>
    tierConds.every((c: Record<string, unknown>) => evalLogic(c, { attributes: e.attributes }))
  // If this type has a capacity_attribute (e.g. RAM modules), prefer higher-capacity
  // units first so kits (modules=2) are tried before individual sticks (modules=1).
  // Within the same module count, sort by descending unit cost as usual.
  const capAttrKey = cfg.dynamicMaxPerType[type]?.capacity_attribute
  const byPreference = (a: Entity, b: Entity): number => {
    if (capAttrKey) {
      const diff = Number(b.attributes[capAttrKey] ?? 1) - Number(a.attributes[capAttrKey] ?? 1)
      if (diff !== 0) return diff
    }
    return unitCost(b, cfg) - unitCost(a, cfg)
  }
  const candidates = [
    ...pairwiseOk.filter(satisfiesTier).sort(byPreference),
    ...pairwiseOk.filter((e) => !satisfiesTier(e)).sort(byPreference),
  ]

  for (const candidate of candidates) {
    const cost = unitCost(candidate, cfg)
    if (cost > remainingBudget) continue
    const result = recurse({ ...chosen, [type]: candidate }, remainingBudget - cost)
    if (result !== null) return result
  }

  return null
}

// Fills types in toFill for a given anchor entity.
// Uses generic recursive backtracking driven by cfg.selectionOrder.
// Priority: highest-cost candidate first; capacityType always cheapest adequate.
function tryFillPackage(
  anchorEntity: Entity | null,
  context: Entity[],
  available: Entity[],
  rules: CompatibilityRule[],
  cfg: DomainConfig,
  budget: number,
  capacityFactor: number,
  toFill: Set<string>,
): Record<string, SlotItem[]> | null {
  const anchorType: string = cfg.anchorType ?? cfg.fillOrder[0]!

  const resolvedAnchor: Entity | null = toFill.has(anchorType)
    ? anchorEntity
    : (context.find((e) => e.entity_type === anchorType) ?? null)

  let budgetAfterAnchor = budget
  if (toFill.has(anchorType) && anchorEntity !== null) {
    const cost = unitCost(anchorEntity, cfg)
    if (cost > budget) return null
    budgetAfterAnchor -= cost
  }

  const anchorCtx: Entity[] = resolvedAnchor ? [resolvedAnchor] : []

  // Build tier conditions per entity type driven by anchor (data-driven via tierRules config)
  const tierCondsPerType: Record<string, Array<Record<string, unknown>>> = {}
  if (resolvedAnchor) {
    for (const type of cfg.entityTypes) {
      const conds = getTierConditions(resolvedAnchor, cfg.tierRules ?? [], type)
      if (conds.length > 0) tierCondsPerType[type] = conds
    }
  }

  const capacityType: string = cfg.capacityType ?? cfg.fillOrder[cfg.fillOrder.length - 1]!
  const selectionOrder = cfg.selectionOrder ?? cfg.fillOrder.filter((t) => t !== anchorType)

  const chosen = backtrackFill(
    selectionOrder, 0, {}, budgetAfterAnchor,
    context, anchorCtx, tierCondsPerType, available, rules, cfg, toFill, capacityFactor, capacityType,
  )

  if (chosen === null) return null

  // Post-backtrack slot fill: use dynamicMaxPerType to fill remaining capacity slots.
  // After backtrack picks 1 unit, try adding more if the source entity has spare slots and budget allows.
  // Capacity entity is re-evaluated if extra load exceeds current capacity.
  const quantities: Record<string, number> = {}
  const spentInBacktrack = Object.entries(chosen)
    .filter(([t]) => toFill.has(t))
    .reduce((sum, [, e]) => sum + unitCost(e, cfg), 0)
  let remaining = budgetAfterAnchor - spentInBacktrack

  const capAttr = cfg.capacityAttribute ?? 'watt_output'

  for (const [type, dynCfg] of Object.entries(cfg.dynamicMaxPerType) as [string, DynamicMaxCfg][]) {
    if (!dynCfg || !toFill.has(type) || !chosen[type]) continue

    const sourceEntity =
      chosen[dynCfg.source_type] ??
      context.find((e) => e.entity_type === dynCfg.source_type)
    if (!sourceEntity) continue

    const slotCapacity = Number(sourceEntity.attributes[dynCfg.source_attribute] ?? 0)
    const unitCap = dynCfg.capacity_attribute
      ? Number(chosen[type]!.attributes[dynCfg.capacity_attribute] ?? 1)
      : 1
    const maxQty = unitCap > 0 ? Math.floor(slotCapacity / unitCap) : 1
    if (maxQty <= 1) continue

    const kitCost = unitCost(chosen[type]!, cfg)
    const kitLoad = entityLoad(chosen[type]!, cfg)

    const baseLoadItems = [...context, ...anchorCtx, ...Object.values(chosen)]
      .filter((e, i, arr) => arr.indexOf(e) === i && e.entity_type !== capacityType)
    const baseLoad = totalLoadOf(baseLoadItems, cfg)

    for (let extra = maxQty - 1; extra >= 1; extra--) {
      const extraCost = extra * kitCost
      if (extraCost > remaining) continue

      const newLoad = baseLoad + extra * kitLoad
      const newCapMin = newLoad / capacityFactor

      const currentCap = chosen[capacityType]
      if (currentCap && Number(currentCap.attributes[capAttr] ?? 0) >= newCapMin) {
        quantities[type] = 1 + extra
        remaining -= extraCost
        break
      }

      if (toFill.has(capacityType) && currentCap) {
        const oldCapCost = unitCost(currentCap, cfg)
        const budgetForNewCap = remaining - extraCost + oldCapCost
        const newCap = findCheapestCapacity(available, newCapMin, budgetForNewCap, cfg)
        if (newCap) {
          remaining -= extraCost + unitCost(newCap, cfg) - oldCapCost
          chosen[capacityType] = newCap
          quantities[type] = 1 + extra
          break
        }
      }
    }
  }

  // Assemble result slots
  const pkg: Record<string, SlotItem[]> = {}
  if (toFill.has(anchorType) && anchorEntity) pkg[anchorType] = [{ entity: anchorEntity, quantity: 1 }]
  for (const [type, entity] of Object.entries(chosen)) {
    if (!toFill.has(type)) continue
    pkg[type] = [{ entity, quantity: quantities[type] ?? 1 }]
  }

  // Post-fill optional types (e.g. SSD) using remaining budget after full package.
  // Candidates sorted by preferAttribute DESC → biggest affordable wins.
  if (cfg.postFillTypes?.length) {
    const allCtx = [...context, ...anchorCtx, ...Object.values(chosen)]
      .filter((e, i, arr) => arr.indexOf(e) === i)
    for (const { type, preferAttribute } of cfg.postFillTypes) {
      if (!toFill.has(type) || pkg[type]) continue
      const postCandidates = available
        .filter((e) => e.entity_type === type && cachedPairwise(e, allCtx, rules))
        .sort((a, b) => {
          if (preferAttribute) {
            const diff = Number(b.attributes[preferAttribute] ?? 0) - Number(a.attributes[preferAttribute] ?? 0)
            if (diff !== 0) return diff
          }
          return unitCost(b, cfg) - unitCost(a, cfg)
        })
      for (const candidate of postCandidates) {
        if (unitCost(candidate, cfg) <= remaining) {
          pkg[type] = [{ entity: candidate, quantity: 1 }]
          remaining -= unitCost(candidate, cfg)
          break
        }
      }
    }
  }

  return pkg
}

// ── Spec-chain fill ──────────────────────────────────────────────────────────

function specChainFill(
  entities: Entity[],
  rules: CompatibilityRule[],
  cfg: DomainConfig,
  input: {
    budget: number
    pinned: Record<string, SlotItem[]>
    excluded: Record<string, boolean>
    blockedIds: Set<number>
  },
): Record<string, SlotItem[]> {
  const { budget, pinned, excluded, blockedIds } = input
  const result = emptySlots(cfg)

  // Apply pinned items and compute spent-so-far
  let pinnedCost = 0
  for (const type of cfg.entityTypes) {
    if (!excluded[type]) {
      result[type] = (pinned[type] ?? []).map((s) => ({ ...s }))
      pinnedCost += result[type].reduce((s, i) => s + slotCost(i, cfg), 0)
    }
  }
  const effectiveBudget = budget - pinnedCost

  // Available pool: published & not blocked
  const available = entities.filter((e) => e.status === 'published' && !blockedIds.has(e.id))

  // Context: pinned entities (for pairwise compat checks)
  const pinnedEntities = Object.values(result).flatMap((arr) => arr.map((s) => s.entity))

  const capacityFactor = cfg.capacityFactor ?? 0.8
  const anchorType: string = cfg.anchorType ?? cfg.fillOrder[0]!

  // Types that still need filling
  const toFill = new Set(cfg.entityTypes.filter((t) => !excluded[t] && (result[t] ?? []).length === 0))

  if (!toFill.has(anchorType)) {
    // Anchor is pinned or excluded — fill remaining types directly
    const anchorEntity = excluded[anchorType] ? null : (result[anchorType]?.[0]?.entity ?? null)
    const pkg = tryFillPackage(anchorEntity, pinnedEntities, available, rules, cfg, effectiveBudget, capacityFactor, toFill)
    if (pkg) Object.assign(result, pkg)
    return result
  }

  // Iterate anchor candidates (highest cost first), then try without anchor
  const anchorCandidates = available
    .filter((e) => e.entity_type === anchorType)
    .sort((a, b) => unitCost(b, cfg) - unitCost(a, cfg))

  for (const anchor of anchorCandidates) {
    const pkg = tryFillPackage(anchor, pinnedEntities, available, rules, cfg, effectiveBudget, capacityFactor, toFill)
    if (pkg) {
      Object.assign(result, pkg)
      return result
    }
  }

  // No anchor package fits — try without anchor
  const noAnchorFill = new Set([...toFill].filter((t) => t !== anchorType))
  const pkg = tryFillPackage(null, pinnedEntities, available, rules, cfg, effectiveBudget, capacityFactor, noAnchorFill)
  if (pkg) Object.assign(result, pkg)

  return result
}

// ── Public API ───────────────────────────────────────────────────────────────

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
  const blockedIds = new Set(input.blockedIds ?? [])

  const slots = specChainFill(entities, rules, cfg, {
    budget: input.budget ?? Infinity,
    pinned,
    excluded,
    blockedIds,
  })

  return { slots, overflow: false }
}

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
