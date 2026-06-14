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
  psuSafetyFactor?: number
  // Priority order for non-GPU component selection (desc cost). PSU always last (cheapest adequate).
  // Defaults to fillOrder minus 'gpu'. Configure per domain to control budget allocation priority.
  selectionOrder?: string[]
  // The type that uses cheapest-adequate selection instead of best-first. Defaults to 'psu'.
  capacityType?: string
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

// ── Spec-chain engine helpers ────────────────────────────────────────────────

function findCheapestPsu(
  available: Entity[],
  minWatts: number,
  maxCost: number,
  cfg: DomainConfig,
): Entity | null {
  return available
    .filter((e) =>
      e.entity_type === 'psu' &&
      Number(e.attributes['watt_output'] ?? 0) >= minWatts &&
      unitCost(e, cfg) <= maxCost
    )
    .sort((a, b) => unitCost(a, cfg) - unitCost(b, cfg))[0] ?? null
}

function totalPowerOf(entities: Entity[]): number {
  return entities.reduce(
    (sum, e) => sum + Number(e.attributes['power_draw_w'] ?? e.attributes['tdp_w'] ?? 0),
    0,
  )
}

// Generic recursive backtracking fill.
// Iterates selectionOrder types in priority sequence, trying highest-cost candidates first.
// capacityType (default 'psu') uses cheapest-adequate selection instead of best-first.
// Returns chosen entity map or null if no valid combination fits within budget.
function backtrackFill(
  selectionOrder: string[],
  index: number,
  chosen: Record<string, Entity>,
  remainingBudget: number,
  context: Entity[],
  gpuCtx: Entity[],
  tierCondsPerType: Record<string, Array<Record<string, unknown>>>,
  available: Entity[],
  rules: CompatibilityRule[],
  cfg: DomainConfig,
  toFill: Set<string>,
  psuFactor: number,
  capacityType: string,
): Record<string, Entity> | null {
  if (index === selectionOrder.length) return chosen

  const type: string = selectionOrder[index]!
  const recurse = (next: Record<string, Entity>, budget: number) =>
    backtrackFill(selectionOrder, index + 1, next, budget, context, gpuCtx, tierCondsPerType, available, rules, cfg, toFill, psuFactor, capacityType)

  if (!toFill.has(type)) return recurse(chosen, remainingBudget)

  // Capacity type (e.g. PSU): cheapest that meets the aggregate requirement
  if (type === capacityType) {
    const powerItems = [...context, ...gpuCtx, ...Object.values(chosen)]
      .filter((e, i, arr) => arr.indexOf(e) === i && e.entity_type !== capacityType)
    const psu = findCheapestPsu(available, totalPowerOf(powerItems) / psuFactor, remainingBudget, cfg)
    if (!psu) return null
    return { ...chosen, [type]: psu }
  }

  // Regular component: check pairwise compatibility, then sort by tier preference + cost.
  // Tier conditions are SOFT PREFERENCES: tier-satisfying candidates are tried first (desc cost),
  // followed by non-tier candidates (desc cost) as fallback. GPU is never blocked by tier alone.
  const allCtx = [...context, ...gpuCtx, ...Object.values(chosen)]
  const tierConds: Array<Record<string, unknown>> = tierCondsPerType[type] ?? []
  const pairwiseOk = available.filter((e) =>
    e.entity_type === type && cachedPairwise(e, allCtx, rules)
  )
  const satisfiesTier = (e: Entity): boolean =>
    tierConds.every((c: Record<string, unknown>) => evalLogic(c, { attributes: e.attributes }))
  const byDescCost = (a: Entity, b: Entity): number => unitCost(b, cfg) - unitCost(a, cfg)
  const candidates = [
    ...pairwiseOk.filter(satisfiesTier).sort(byDescCost),
    ...pairwiseOk.filter((e) => !satisfiesTier(e)).sort(byDescCost),
  ]

  for (const candidate of candidates) {
    const cost = unitCost(candidate, cfg)
    if (cost > remainingBudget) continue
    const result = recurse({ ...chosen, [type]: candidate }, remainingBudget - cost)
    if (result !== null) return result
  }

  return null
}

// Fills types in toFill for a given GPU anchor.
// Uses generic recursive backtracking driven by cfg.selectionOrder (defaults to fillOrder minus gpu).
// Priority: highest-cost candidate first for each type; capacity type (psu) always cheapest adequate.
function tryFillPackage(
  gpuAnchor: Entity | null,
  context: Entity[],
  available: Entity[],
  rules: CompatibilityRule[],
  cfg: DomainConfig,
  budget: number,
  psuFactor: number,
  toFill: Set<string>,
): Record<string, SlotItem[]> | null {
  const gpuEntity: Entity | null = toFill.has('gpu')
    ? gpuAnchor
    : (context.find((e) => e.entity_type === 'gpu') ?? null)

  let budgetAfterGpu = budget
  if (toFill.has('gpu') && gpuAnchor !== null) {
    const cost = unitCost(gpuAnchor, cfg)
    if (cost > budget) return null
    budgetAfterGpu -= cost
  }

  const gpuCtx: Entity[] = gpuEntity ? [gpuEntity] : []

  // Build tier conditions per entity type driven by GPU (data-driven via tierRules config)
  const tierCondsPerType: Record<string, Array<Record<string, unknown>>> = {}
  if (gpuEntity) {
    for (const type of cfg.entityTypes) {
      const conds = getTierConditions(gpuEntity, cfg.tierRules ?? [], type)
      if (conds.length > 0) tierCondsPerType[type] = conds
    }
  }

  const capacityType = cfg.capacityType ?? 'psu'

  // Selection order from config; fallback: fillOrder minus gpu (GPU handled by specChainFill above)
  const selectionOrder = cfg.selectionOrder ?? cfg.fillOrder.filter((t) => t !== 'gpu')

  const chosen = backtrackFill(
    selectionOrder, 0, {}, budgetAfterGpu,
    context, gpuCtx, tierCondsPerType, available, rules, cfg, toFill, psuFactor, capacityType,
  )

  if (chosen === null) return null

  // Post-backtrack slot fill: use dynamicMaxPerType config to fill remaining capacity.
  // E.g. RAM: backtrack picks 1 kit; here we add more kits if MB has spare slots and budget allows.
  // Budget and PSU are re-evaluated so power limits are respected.
  const quantities: Record<string, number> = {}
  const spentInBacktrack = Object.entries(chosen)
    .filter(([t]) => toFill.has(t))
    .reduce((sum, [, e]) => sum + unitCost(e, cfg), 0)
  let remaining = budgetAfterGpu - spentInBacktrack

  for (const [type, dynCfg] of Object.entries(cfg.dynamicMaxPerType) as [string, DynamicMaxCfg][]) {
    if (!dynCfg || !toFill.has(type) || !chosen[type]) continue

    // Source entity (e.g. MB) may come from chosen or from pinned context
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
    const kitPower = Number(chosen[type]!.attributes['power_draw_w'] ?? 0)

    // Base power already sized for 1 unit; extras add proportional power
    const basePowerItems = [...context, ...gpuCtx, ...Object.values(chosen)]
      .filter((e, i, arr) => arr.indexOf(e) === i && e.entity_type !== capacityType)
    const basePower = totalPowerOf(basePowerItems)

    // Try adding as many extra units as possible (maxQty-1 down to 1)
    for (let extra = maxQty - 1; extra >= 1; extra--) {
      const extraCost = extra * kitCost
      if (extraCost > remaining) continue

      const newPower = basePower + extra * kitPower
      const newPsuMin = newPower / psuFactor

      // Check current capacity entity handles new load
      const currentCap = chosen[capacityType]
      if (currentCap && Number(currentCap.attributes['watt_output'] ?? 0) >= newPsuMin) {
        quantities[type] = 1 + extra
        remaining -= extraCost
        break
      }

      // Try to upgrade capacity entity within remaining budget
      if (toFill.has(capacityType) && currentCap) {
        const oldCapCost = unitCost(currentCap, cfg)
        const budgetForNewCap = remaining - extraCost + oldCapCost
        const newCap = findCheapestPsu(available, newPsuMin, budgetForNewCap, cfg)
        if (newCap) {
          remaining -= extraCost + unitCost(newCap, cfg) - oldCapCost
          chosen[capacityType] = newCap
          quantities[type] = 1 + extra
          break
        }
      }
    }
  }

  // Assemble result slots — quantity from slot-fill pass or 1 if not filled
  const pkg: Record<string, SlotItem[]> = {}
  if (toFill.has('gpu') && gpuAnchor) pkg['gpu'] = [{ entity: gpuAnchor, quantity: 1 }]
  for (const [type, entity] of Object.entries(chosen)) {
    if (!toFill.has(type)) continue
    pkg[type] = [{ entity, quantity: quantities[type] ?? 1 }]
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

  // Context: pinned entities (already in result, for pairwise compat checks)
  const pinnedEntities = Object.values(result).flatMap((arr) => arr.map((s) => s.entity))

  const psuFactor = cfg.psuSafetyFactor ?? 0.8

  // Types that still need filling
  const toFill = new Set(cfg.entityTypes.filter((t) => !excluded[t] && (result[t] ?? []).length === 0))

  if (!toFill.has('gpu')) {
    // GPU is pinned or excluded — fill remaining types directly
    const gpuAnchor = excluded['gpu'] ? null : (result['gpu']?.[0]?.entity ?? null)
    const pkg = tryFillPackage(gpuAnchor, pinnedEntities, available, rules, cfg, effectiveBudget, psuFactor, toFill)
    if (pkg) Object.assign(result, pkg)
    return result
  }

  // Iterate GPU candidates (highest cost first), then try no-GPU
  const gpuCandidates = available
    .filter((e) => e.entity_type === 'gpu')
    .sort((a, b) => unitCost(b, cfg) - unitCost(a, cfg))

  for (const gpu of gpuCandidates) {
    const pkg = tryFillPackage(gpu, pinnedEntities, available, rules, cfg, effectiveBudget, psuFactor, toFill)
    if (pkg) {
      Object.assign(result, pkg)
      return result
    }
  }

  // No GPU package fits — try without GPU
  const noGpuFill = new Set([...toFill].filter((t) => t !== 'gpu'))
  const pkg = tryFillPackage(null, pinnedEntities, available, rules, cfg, effectiveBudget, psuFactor, noGpuFill)
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

  return { slots, overflow: false, repairedBlockedIds: [] }
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
