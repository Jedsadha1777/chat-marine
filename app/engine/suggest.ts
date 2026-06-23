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
  sort_attribute?: string   // preferred sort key (e.g. capacity_gb); falls back to capacity_attribute
  fallback: number
}

export interface PostFillCfg {
  type: string
  preferAttribute?: string
  maxAttrValue?: number      // cap: only candidates where preferAttribute <= this
  minAttrValue?: number      // floor: only candidates where preferAttribute >= this
  upgradeExisting?: boolean  // phase 3: runs after quantities, replaces prior pick if upgrade affordable
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
  anchorType?: string
  selectionOrder?: string[]
  capacityType?: string
  capacityAttribute?: string
  loadAttributes?: string[]
  capacityFactor?: number
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

  if (type === capacityType) {
    const loadItems = [...context, ...anchorCtx, ...Object.values(chosen)]
      .filter((e, i, arr) => arr.indexOf(e) === i && e.entity_type !== capacityType)
    const cap = findCheapestCapacity(available, totalLoadOf(loadItems, cfg) / capacityFactor, remainingBudget, cfg)
    if (!cap) return null
    return { ...chosen, [type]: cap }
  }

  const allCtx = [...context, ...anchorCtx, ...Object.values(chosen)]
  const tierConds: Array<Record<string, unknown>> = tierCondsPerType[type] ?? []
  const pairwiseOk = available.filter((e) =>
    e.entity_type === type && cachedPairwise(e, allCtx, rules)
  )
  const satisfiesTier = (e: Entity): boolean =>
    tierConds.every((c: Record<string, unknown>) => evalLogic(c, { attributes: e.attributes }))
  // Sort by sort_attribute (e.g. capacity_gb) desc first, then capacity_attribute (e.g. modules) desc, then cost.
  const sortAttrKey = cfg.dynamicMaxPerType[type]?.sort_attribute
  const capAttrKey  = cfg.dynamicMaxPerType[type]?.capacity_attribute
  const byPreference = (a: Entity, b: Entity): number => {
    if (sortAttrKey) {
      const diff = Number(b.attributes[sortAttrKey] ?? 0) - Number(a.attributes[sortAttrKey] ?? 0)
      if (diff !== 0) return diff
    }
    if (capAttrKey) {
      const diff = Number(b.attributes[capAttrKey] ?? 1) - Number(a.attributes[capAttrKey] ?? 1)
      if (diff !== 0) return diff
    }
    return unitCost(b, cfg) - unitCost(a, cfg)
  }
  // Each non-capacity type gets an equal share of remaining budget — tried first; over-share as fallback.
  const remainingSlots = selectionOrder.slice(index).filter(t => toFill.has(t) && t !== capacityType).length
  const shareMax = remainingSlots > 0 ? Math.floor(remainingBudget / remainingSlots) : remainingBudget
  const inShare  = (e: Entity) => unitCost(e, cfg) <= shareMax
  const candidates = [
    ...pairwiseOk.filter(e => inShare(e)  && satisfiesTier(e)).sort(byPreference),
    ...pairwiseOk.filter(e => inShare(e)  && !satisfiesTier(e)).sort(byPreference),
    ...pairwiseOk.filter(e => !inShare(e) && satisfiesTier(e)).sort(byPreference),
    ...pairwiseOk.filter(e => !inShare(e) && !satisfiesTier(e)).sort(byPreference),
  ]

  for (const candidate of candidates) {
    const cost = unitCost(candidate, cfg)
    if (cost > remainingBudget) continue
    const result = recurse({ ...chosen, [type]: candidate }, remainingBudget - cost)
    if (result !== null) return result
  }

  return null
}

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

  const tierCondsPerType: Record<string, Array<Record<string, unknown>>> = {}
  if (resolvedAnchor) {
    for (const type of cfg.entityTypes) {
      const conds = getTierConditions(resolvedAnchor, cfg.tierRules ?? [], type)
      if (conds.length > 0) tierCondsPerType[type] = conds
    }
  }

  const capacityType: string = cfg.capacityType ?? cfg.fillOrder[cfg.fillOrder.length - 1]!
  const selectionOrder = cfg.selectionOrder ?? cfg.fillOrder.filter((t) => t !== anchorType)

  // Reduce backtrack budget by cheapest postFill costs so SSD always has room; restored in `remaining`.
  const minPostFillReserve = (cfg.postFillTypes ?? [])
    .filter((pf) => !pf.upgradeExisting && toFill.has(pf.type))
    .reduce((reserve, pf) => {
      const cheapest = available
        .filter((e) => e.entity_type === pf.type)
        .reduce((min, e) => Math.min(min, unitCost(e, cfg)), Infinity)
      return reserve + (isFinite(cheapest) ? cheapest : 0)
    }, 0)

  const chosen = backtrackFill(
    selectionOrder, 0, {}, budgetAfterAnchor - minPostFillReserve,
    context, anchorCtx, tierCondsPerType, available, rules, cfg, toFill, capacityFactor, capacityType,
  )

  if (chosen === null) return null

  const quantities: Record<string, number> = {}
  const spentInBacktrack = Object.entries(chosen)
    .filter(([t]) => toFill.has(t))
    .reduce((sum, [, e]) => sum + unitCost(e, cfg), 0)
  let remaining = budgetAfterAnchor - spentInBacktrack

  const capAttr = cfg.capacityAttribute ?? 'watt_output'

  const postFilled: Record<string, SlotItem[]> = {}
  const allCtxForPost = [...context, ...anchorCtx, ...Object.values(chosen)]
    .filter((e, i, arr) => arr.indexOf(e) === i)
  for (const { type, preferAttribute, maxAttrValue, minAttrValue, upgradeExisting } of cfg.postFillTypes ?? []) {
    if (upgradeExisting) continue  // phase 3 runs later
    if (!toFill.has(type)) continue
    const postCandidates = available
      .filter((e) => {
        if (e.entity_type !== type || !cachedPairwise(e, allCtxForPost, rules)) return false
        if (preferAttribute) {
          const v = Number(e.attributes[preferAttribute] ?? 0)
          if (maxAttrValue !== undefined && v > maxAttrValue) return false
          if (minAttrValue !== undefined && v < minAttrValue) return false
        }
        return true
      })
      .sort((a, b) => {
        if (preferAttribute) {
          const diff = Number(b.attributes[preferAttribute] ?? 0) - Number(a.attributes[preferAttribute] ?? 0)
          if (diff !== 0) return diff
        }
        return unitCost(b, cfg) - unitCost(a, cfg)
      })
    for (const candidate of postCandidates) {
      if (unitCost(candidate, cfg) <= remaining) {
        postFilled[type] = [{ entity: candidate, quantity: 1 }]
        remaining -= unitCost(candidate, cfg)
        break
      }
    }
  }

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

  for (const { type, preferAttribute, maxAttrValue, minAttrValue, upgradeExisting } of cfg.postFillTypes ?? []) {
    if (!upgradeExisting) continue
    if (!toFill.has(type)) continue
    const existing = postFilled[type]?.[0]?.entity ?? null
    const existingCost = existing ? unitCost(existing, cfg) : 0
    const upgradeCandidates = available
      .filter((e) => {
        if (e.entity_type !== type || !cachedPairwise(e, allCtxForPost, rules)) return false
        if (preferAttribute) {
          const v = Number(e.attributes[preferAttribute] ?? 0)
          if (maxAttrValue !== undefined && v > maxAttrValue) return false
          if (minAttrValue !== undefined && v < minAttrValue) return false
        }
        return true
      })
      .sort((a, b) => {
        if (preferAttribute) {
          const diff = Number(a.attributes[preferAttribute] ?? 0) - Number(b.attributes[preferAttribute] ?? 0)
          if (diff !== 0) return diff  // ASC: smallest upgrade first
        }
        return unitCost(a, cfg) - unitCost(b, cfg)
      })
    for (const candidate of upgradeCandidates) {
      const upgradeCost = unitCost(candidate, cfg) - existingCost
      if (upgradeCost <= remaining) {
        postFilled[type] = [{ entity: candidate, quantity: 1 }]
        remaining -= upgradeCost
        break
      }
    }
  }

  // ── Budget redistribution loop: cycle every slot until no upgrade fits remaining budget ──────
  {
    const upgradeOrder: string[] = [
      ...(cfg.selectionOrder ?? []).filter((t) => t !== capacityType),
      ...[...new Set((cfg.postFillTypes ?? []).filter((pf) => !pf.upgradeExisting).map((pf) => pf.type))],
      capacityType,
    ]
    const slotFor = (type: string): Entity | null =>
      postFilled[type]?.[0]?.entity ?? chosen[type] ?? null

    let anyUpgraded = true
    while (anyUpgraded && remaining > 0) {
      anyUpgraded = false
      for (const type of upgradeOrder) {
        if (!toFill.has(type)) continue
        if ((quantities[type] ?? 1) > 1) continue
        const current = slotFor(type)
        if (!current) continue
        const currentCost = unitCost(current, cfg)

        const ctxWithout = [
          ...context, ...anchorCtx,
          ...Object.entries(chosen).filter(([t]) => t !== type).map(([, e]) => e),
          ...Object.entries(postFilled).filter(([t]) => t !== type).flatMap(([, s]) => s.map((i) => i.entity)),
        ]

        const capAttr = cfg.capacityAttribute ?? 'watt_output'
        const minCapWatt = type === capacityType ? Number(current.attributes[capAttr] ?? 0) : 0

        const best = available
          .filter((e) => {
            if (e.entity_type !== type || e.id === current.id) return false
            const cost = unitCost(e, cfg)
            if (cost <= currentCost || cost - currentCost > remaining) return false
            if (!cachedPairwise(e, ctxWithout, rules)) return false
            if (minCapWatt > 0 && Number(e.attributes[capAttr] ?? 0) < minCapWatt) return false
            return true
          })
          .sort((a, b) => unitCost(b, cfg) - unitCost(a, cfg))[0] ?? null

        if (best) {
          remaining -= unitCost(best, cfg) - currentCost
          if (postFilled[type]?.length) {
            postFilled[type] = [{ entity: best, quantity: 1 }]
          } else {
            chosen[type] = best
          }
          anyUpgraded = true
        }
      }
    }
  }

  const pkg: Record<string, SlotItem[]> = {}
  if (toFill.has(anchorType) && anchorEntity) pkg[anchorType] = [{ entity: anchorEntity, quantity: 1 }]
  for (const [type, entity] of Object.entries(chosen)) {
    if (!toFill.has(type)) continue
    pkg[type] = [{ entity, quantity: quantities[type] ?? 1 }]
  }
  Object.assign(pkg, postFilled)

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

  let pinnedCost = 0
  for (const type of cfg.entityTypes) {
    if (!excluded[type]) {
      result[type] = (pinned[type] ?? []).map((s) => ({ ...s }))
      pinnedCost += result[type].reduce((s, i) => s + slotCost(i, cfg), 0)
    }
  }
  const effectiveBudget = budget - pinnedCost

  const available = entities.filter((e) => e.status === 'published' && !blockedIds.has(e.id))
  const pinnedEntities = Object.values(result).flatMap((arr) => arr.map((s) => s.entity))

  const capacityFactor = cfg.capacityFactor ?? 0.8
  const anchorType: string = cfg.anchorType ?? cfg.fillOrder[0]!

  const toFill = new Set(cfg.entityTypes.filter((t) => !excluded[t] && (result[t] ?? []).length === 0))

  if (!toFill.has(anchorType)) {
    const anchorEntity = excluded[anchorType] ? null : (result[anchorType]?.[0]?.entity ?? null)
    const pkg = tryFillPackage(anchorEntity, pinnedEntities, available, rules, cfg, effectiveBudget, capacityFactor, toFill)
    if (pkg) Object.assign(result, pkg)
    return result
  }

  // Anchor target = proportional budget share so anchor doesn't consume all budget.
  const anchorTarget = Math.round(effectiveBudget * Math.ceil(cfg.entityTypes.length / 2) / cfg.entityTypes.length)
  const anchorCandidates = available
    .filter((e) => e.entity_type === anchorType)
    .sort((a, b) => Math.abs(unitCost(a, cfg) - anchorTarget) - Math.abs(unitCost(b, cfg) - anchorTarget))

  for (const anchor of anchorCandidates) {
    const pkg = tryFillPackage(anchor, pinnedEntities, available, rules, cfg, effectiveBudget, capacityFactor, toFill)
    if (pkg) {
      Object.assign(result, pkg)
      return result
    }
  }

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
        message:    `${cfg.entityTypeLabels[t] ?? t} is missing from the configuration`,
        resolution: `Add at least one ${cfg.entityTypeLabels[t] ?? t}`,
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
