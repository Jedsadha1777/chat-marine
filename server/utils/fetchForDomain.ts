import type { D1Database } from '@cloudflare/workers-types'
import type { DomainConfig } from '~/engine/suggest'
import type { SlotItem } from '~/engine/suggest'
import type { Entity } from '~/data/types'
import { fetchCandidates, fetchCheapestCandidates, fetchByIds, dbConfigFrom } from './db'

const DEFAULT_FETCH_LIMITS = {
  anchor:     60,
  anchorNear: 20,
  capacity:   50,
  core:       25,
  coreCheap:  25,
}

interface FetchInput {
  budget: number | null
  pinnedEntities: Record<string, SlotItem[]>
  excluded: Record<string, boolean>
  blockedIds: number[]
}

export async function fetchForDomain(
  DB: D1Database,
  cfg: DomainConfig,
  input: FetchInput,
): Promise<Entity[]> {
  const { budget, pinnedEntities, excluded, blockedIds } = input
  const limits = { ...DEFAULT_FETCH_LIMITS, ...cfg.fetchLimits }
  const dbCfg = dbConfigFrom(cfg)

  const maxCost = budget ?? 999_999_999
  const anchorType   = cfg.anchorType   ?? cfg.fillOrder[0]!
  const capacityType = cfg.capacityType ?? cfg.fillOrder[cfg.fillOrder.length - 1]!

  const pinnedCostTotal = Object.values(pinnedEntities)
    .flat()
    .reduce((sum, s) => sum + Number(s.entity.attributes[cfg.costAttribute] ?? 0) * s.quantity, 0)
  const effectiveMax = budget !== null ? Math.max(0, budget - pinnedCostTotal) : 999_999_999

  const coreTypes = cfg.entityTypes.filter((t) => t !== anchorType && t !== capacityType)
  const coreFilledTypes = coreTypes.filter(
    (t) => !excluded[t] && (pinnedEntities[t]?.length ?? 0) === 0,
  )
  const perSlot = coreFilledTypes.length > 0
    ? Math.round(effectiveMax / coreFilledTypes.length)
    : effectiveMax

  const anchorTarget = Math.round(
    effectiveMax * Math.ceil(cfg.entityTypes.length / 2) / cfg.entityTypes.length,
  )
  const anchorFillable = !(excluded[anchorType] || (pinnedEntities[anchorType]?.length ?? 0) > 0)

  const [mainResults, nearTargetResults, cheapResults] = await Promise.all([
    Promise.all(
      cfg.entityTypes.map((type) => {
        if (excluded[type] || (pinnedEntities[type]?.length ?? 0) > 0) return Promise.resolve([] as Entity[])
        if (type === anchorType)   return fetchCandidates(DB, type, effectiveMax, blockedIds, limits.anchor,     dbCfg)
        if (type === capacityType) return fetchCandidates(DB, type, maxCost,      blockedIds, limits.capacity,   dbCfg)
        return fetchCandidates(DB, type, perSlot, blockedIds, limits.core, dbCfg)
      }),
    ),
    anchorFillable
      ? fetchCandidates(DB, anchorType, anchorTarget, blockedIds, limits.anchorNear, dbCfg)
      : Promise.resolve([] as Entity[]),
    Promise.all(
      coreFilledTypes.map((type) =>
        fetchCheapestCandidates(DB, type, perSlot, blockedIds, limits.coreCheap, dbCfg),
      ),
    ),
  ])

  const seenIds = new Set<number>()
  return [
    ...Object.values(pinnedEntities).flat().map((s) => s.entity),
    ...[...mainResults.flat(), ...nearTargetResults, ...cheapResults.flat()].filter((e) => {
      if (seenIds.has(e.id)) return false
      seenIds.add(e.id)
      return true
    }),
  ]
}

export { fetchByIds }
