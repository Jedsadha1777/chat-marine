import type { Entity, CompatibilityRule } from '~/data/types'
import { evalLogic } from '~/engine/pairwise'
import type { DomainConfig, DynamicMaxCfg, SlotItem } from '../engine-types'
import { unitCost, slotCost, emptySlots, cachedPairwise, getTierConditions } from '../engine-helpers'
import { prepareModule, evalModule } from '../ruleflow/index'
import type { Module, PreparedModule } from '../ruleflow/index'
import type { FillInput, FillStrategy } from './types'

// ── Budget plan preparation (cached per Module object) ────────────────────────

const DEFAULT_BUDGET_PLAN = prepareModule({
  name: 'default-budget-plan', ver: '1',
  inputs: [
    { name: 'effectiveBudget', type: 'num' },
    { name: 'entityCount',     type: 'num' },
  ],
  outputs: ['anchorTarget'],
  blocks: [
    {
      id: 'anchor', out: ['anchorTarget', 'num'] as ['anchorTarget', 'num'],
      expr: 'round($effectiveBudget * ceil($entityCount / 2) / $entityCount)',
    },
  ],
})

const _planCache = new WeakMap<Module, PreparedModule>()

function getPreparedPlan(plan: Module | undefined): PreparedModule {
  if (!plan) return DEFAULT_BUDGET_PLAN
  let prepared = _planCache.get(plan)
  if (!prepared) { prepared = prepareModule(plan); _planCache.set(plan, prepared) }
  return prepared
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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

  const minPostFillReserve = (cfg.postFillTypes ?? [])
    .filter((pf) => !pf.upgradeExisting && toFill.has(pf.type))
    .reduce((reserve, pf) => {
      const cheapest = available
        .filter((e) => {
          if (e.entity_type !== pf.type) return false
          if (pf.preferAttribute !== undefined) {
            const v = Number(e.attributes[pf.preferAttribute] ?? 0)
            if (pf.minAttrValue !== undefined && v < pf.minAttrValue) return false
            if (pf.maxAttrValue !== undefined && v > pf.maxAttrValue) return false
          }
          return true
        })
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
    if (upgradeExisting) continue
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
          if (diff !== 0) return diff
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

  // Budget redistribution — cycle every slot until no upgrade fits
  {
    const upgradeOrder: string[] = [
      ...(cfg.selectionOrder ?? []).filter((t) => t !== capacityType),
      ...[...new Set((cfg.postFillTypes ?? []).filter((pf) => !pf.upgradeExisting).map((pf) => pf.type))],
      capacityType,
    ]
    const slotFor = (t: string): Entity | null =>
      postFilled[t]?.[0]?.entity ?? chosen[t] ?? null

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

        const localCapAttr = cfg.capacityAttribute ?? 'watt_output'
        const minCapWatt = type === capacityType ? Number(current.attributes[localCapAttr] ?? 0) : 0

        const best = available
          .filter((e) => {
            if (e.entity_type !== type || e.id === current.id) return false
            const cost = unitCost(e, cfg)
            if (cost <= currentCost || cost - currentCost > remaining) return false
            if (!cachedPairwise(e, ctxWithout, rules)) return false
            if (minCapWatt > 0 && Number(e.attributes[localCapAttr] ?? 0) < minCapWatt) return false
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

// ── BacktrackFillStrategy ─────────────────────────────────────────────────────

export class BacktrackFillStrategy implements FillStrategy {
  fill({ entities, cfg, budget, pinned, excluded, blockedIds }: FillInput): Record<string, SlotItem[]> {
    const rules = cfg.rules
    const result = emptySlots(cfg)

    let pinnedCost = 0
    for (const type of cfg.entityTypes) {
      if (!excluded[type]) {
        result[type] = (pinned[type] ?? []).map((s) => ({ ...s }))
        pinnedCost += result[type].reduce((s, i) => s + slotCost(i, cfg), 0)
      }
    }
    const effectiveBudget = budget - pinnedCost

    const available = entities.filter((e) => e.status === (cfg.publishedStatus ?? 'published') && !blockedIds.has(e.id))
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

    // Resolve anchorTarget via budgetPlan module (config-driven or default heuristic)
    const planOut = evalModule(getPreparedPlan(cfg.budgetPlan), { effectiveBudget, entityCount: cfg.entityTypes.length })
    const anchorTarget = Number(planOut['anchorTarget'] ?? 0)

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
}
