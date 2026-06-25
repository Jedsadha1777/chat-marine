import type { Entity, SimulationItem, ValidationIssue, BomItem } from '~/data/types'
import { runPairwise } from '~/engine/pairwise'
import { runAggregate, getAggregateDetail } from '~/engine/aggregate'
import { getStrategy } from './strategies/index'
import { unitCost, slotCost, emptySlots, toSimItems, maxFor, usedCapacity, uniqueEntities, cachedPairwise } from './engine-helpers'
import type { DomainConfig, SlotItem, SuggestInput, SuggestResult } from './engine-types'

export type { DomainConfig, SlotItem, SuggestInput, SuggestResult, FetchLimits, TierRule, DynamicMaxCfg, PostFillCfg } from './engine-types'
export { unitCost, slotCost, emptySlots, toSimItems, maxFor, usedCapacity, uniqueEntities, cachedPairwise }

export function buildSuggestion(entities: Entity[], cfg: DomainConfig, input: SuggestInput): SuggestResult {
  const pinned = Object.fromEntries(
    cfg.entityTypes.map((t) => [t, input.pinned?.[t] ?? []]),
  ) as Record<string, SlotItem[]>
  const excluded = Object.fromEntries(
    cfg.entityTypes.map((t) => [t, input.excluded?.[t] ?? false]),
  ) as Record<string, boolean>
  const blockedIds = new Set(input.blockedIds ?? [])

  const strategy = getStrategy(cfg.fillStrategy)
  const slots = strategy.fill({ entities, cfg, budget: input.budget ?? Infinity, pinned, excluded, blockedIds })

  return { slots, overflow: false }
}

export function validateItems(
  items: SimulationItem[],
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

  const activeRules = [...cfg.rules].filter((r) => r.is_active).sort((a, b) => b.priority - a.priority)
  const uniq = uniqueEntities(items.map((i) => i.entity))
  for (const rule of activeRules) {
    if (rule.check_type === 'pairwise') result.push(...runPairwise(rule, uniq))
    else result.push(...runAggregate(rule, items, constraints))
  }
  return result
}

export function aggregateDetailFor(
  items: SimulationItem[],
  cfg: DomainConfig,
): { aggregate_value: number; capacity_value: number; utilization_pct: number } | null {
  const primaryRule = cfg.rules.find((r) => r.code === cfg.aggregateDisplay.primary && r.is_active)
  if (primaryRule) {
    const detail = getAggregateDetail(primaryRule, items, {})
    if (detail !== null) return detail
  }
  if (cfg.aggregateDisplay.safety) {
    const safetyRule = cfg.rules.find((r) => r.code === cfg.aggregateDisplay.safety && r.is_active)
    if (safetyRule) {
      const detail = getAggregateDetail(safetyRule, items, {})
      if (detail !== null) return detail
    }
  }
  return null
}

export function buildBom(slots: Record<string, SlotItem[]>, cfg: DomainConfig): BomItem[] {
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
