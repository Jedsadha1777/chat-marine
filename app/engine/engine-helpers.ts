import type { Entity, CompatibilityRule, SimulationItem } from '~/data/types'
import { runPairwise, evalLogic } from '~/engine/pairwise'
import type { DomainConfig, SlotItem, TierRule } from './engine-types'

export function unitCost(e: Entity, cfg: DomainConfig): number {
  const raw = e.attributes[cfg.costAttribute] ?? 0
  return parseFloat(Number(raw).toFixed(cfg.costPrecision))
}

export function slotCost(s: SlotItem, cfg: DomainConfig): number {
  return unitCost(s.entity, cfg) * s.quantity
}

export function emptySlots(cfg: DomainConfig): Record<string, SlotItem[]> {
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

export function getTierConditions(
  provider: Entity,
  rules: TierRule[],
  requiredType: string,
): Record<string, unknown>[] {
  return rules
    .filter(r =>
      r.provider.entity_type === provider.entity_type &&
      evalLogic(r.provider.condition, { attributes: provider.attributes })
    )
    .flatMap(r =>
      r.requires.filter(req => req.entity_type === requiredType).map(req => req.condition)
    )
}
