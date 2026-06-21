import { buildSuggestion, validateItems, aggregateDetailFor, buildBom, totalCostOf, toSimItems } from '~/engine/suggest'
import { RULES } from '~/data/rules'
import { DEFAULT_DOMAIN_CONFIG } from '~/composables/simulationConfig'
import { ENTITY_TYPES } from '~/data/entityTypes'
import { fetchCandidates, fetchCandidatesByAttr, fetchByIds } from '../utils/db'
import type { SlotItem } from '~/engine/suggest'
import type { Entity } from '~/data/types'

interface SuggestRequest {
  budget: number | null
  pinned: Record<string, Array<{ id: number; quantity: number }>>
  excluded: Record<string, boolean>
  blockedIds: number[]
}

export default defineEventHandler(async (event) => {
  const body = await readBody<SuggestRequest>(event)

  const budget: number | null   = body.budget ?? null
  const pinnedReq               = body.pinned   ?? {}
  const excluded                = body.excluded  ?? {}
  const blockedIds: number[]    = body.blockedIds ?? []

  const DB = event.context.cloudflare?.env?.DB
  if (!DB) throw createError({ statusCode: 503, message: 'D1 database not available' })

  const maxCost = budget ?? 999_999_999
  const pinnedEntities: Record<string, SlotItem[]> = {}

  const allPinnedIds = Object.values(pinnedReq).flat().map((p) => p.id)
  const pinnedById = new Map((await fetchByIds(DB, allPinnedIds)).map((e) => [e.id, e]))

  for (const type of ENTITY_TYPES) {
    const items = pinnedReq[type] ?? []
    pinnedEntities[type] = items.map((p) => ({
      entity:   pinnedById.get(p.id)!,
      quantity: p.quantity,
    })).filter((s) => s.entity != null)
  }

  // Remaining budget after pinned items — used as the price ceiling for
  // supplemental compatibility queries (see below).
  const pinnedCostTotal = Object.values(pinnedEntities)
    .flat()
    .reduce((sum, s) => sum + Number(s.entity.attributes.unit_cost ?? 0) * s.quantity, 0)
  const effectiveMax = budget !== null ? Math.max(0, budget - pinnedCostTotal) : 999_999_999

  const anchorType   = DEFAULT_DOMAIN_CONFIG.anchorType   ?? 'gpu'
  const capacityType = DEFAULT_DOMAIN_CONFIG.capacityType ?? 'psu'

  // Core types: all entity types except anchor and capacity (from engine config, no hardcoded ratios)
  const coreTypes = ENTITY_TYPES.filter((t) => t !== anchorType && t !== capacityType)

  // Types the engine will fill: non-pinned, non-excluded core types
  const coreFilledTypes = coreTypes.filter((t) =>
    !excluded[t] && (pinnedEntities[t]?.length ?? 0) === 0,
  )

  // Per-slot ceiling: effectiveMax divided equally across all unfilled core slots.
  // Derived entirely from engine config — no hardcoded ratio numbers.
  // Mathematical guarantee: sum of all slot ceilings = effectiveMax → SSD always has room.
  const perSlot = coreFilledTypes.length > 0
    ? Math.round(effectiveMax / coreFilledTypes.length)
    : effectiveMax

  const pinnedRamType   = pinnedEntities['ram']?.[0]?.entity.attributes['ram_type'] as string | undefined
  const pinnedCpuSocket = pinnedEntities['cpu']?.[0]?.entity.attributes['socket'] as string | undefined
  const pinnedMbSocket  = pinnedEntities['motherboard']?.[0]?.entity.attributes['socket'] as string | undefined
  const mbPinned  = (pinnedEntities['motherboard']?.length ?? 0) > 0
  const cpuPinned = (pinnedEntities['cpu']?.length ?? 0) > 0

  // DDR4/AM4 chain: top-20 MB pool at perSlot ceiling skips cheap AM4 boards at high budgets.
  // Supplement fetches all DDR4 MBs within effectiveMax — LIMIT 100 covers all ~59 DDR4 boards
  // (cheapest AM4 boards at 1,335-1,380 sit at positions 53-59 sorted DESC by price).
  const am4Chain = pinnedRamType === 'DDR4' || pinnedCpuSocket === 'AM4' || pinnedMbSocket === 'AM4'

  // DDR5 RAM pinned: cheapest LGA1700 CPU (3,160) may fall below perSlot at tight budgets.
  // Supplement with all LGA1700 CPUs within effectiveMax — LIMIT 30 covers all ~26 LGA1700 CPUs.
  const needSuppLga1700Cpu = pinnedRamType === 'DDR5'

  const [results, suppMbs, suppCpus] = await Promise.all([
    Promise.all(
      ENTITY_TYPES.map((type) => {
        if (excluded[type] || (pinnedEntities[type]?.length ?? 0) > 0) return Promise.resolve([] as Entity[])
        // Anchor: full budget ceiling — picks best GPU that fits overall budget
        if (type === anchorType) return fetchCandidates(DB, type, maxCost, blockedIds, 20)
        // Capacity (PSU): full budget ceiling, LIMIT 50 — cheapest adequate 1000W PSU sits at
        // position 41 in the full DESC price list; LIMIT 50 guarantees it's always reachable
        if (type === capacityType) return fetchCandidates(DB, type, maxCost, blockedIds, 50)
        // SSD: post-filled from remaining budget — needs cheap SSDs (128GB at 270) in pool.
        // 37 total SSDs; LIMIT 40 captures all of them regardless of perSlot ceiling.
        if (type === 'ssd') return fetchCandidates(DB, type, perSlot, blockedIds, 40)
        // Core types: equal per-slot ceiling derived from engine config
        return fetchCandidates(DB, type, perSlot, blockedIds, 20)
      })
    ),
    am4Chain && !excluded['motherboard'] && !mbPinned
      ? fetchCandidatesByAttr(DB, 'motherboard', '$.ram_type', 'DDR4', effectiveMax, blockedIds, 100)
      : Promise.resolve([] as Entity[]),
    needSuppLga1700Cpu && !excluded['cpu'] && !cpuPinned
      ? fetchCandidatesByAttr(DB, 'cpu', '$.socket', 'LGA1700', effectiveMax, blockedIds, 30)
      : Promise.resolve([] as Entity[]),
  ])

  // Deduplicate by entity id — supplemental may overlap with main pool
  const seenIds = new Set<number>()
  const candidates: Entity[] = [
    ...Object.values(pinnedEntities).flat().map((s) => s.entity),
    ...[...results.flat(), ...suppMbs, ...suppCpus].filter((e) => {
      if (seenIds.has(e.id)) return false
      seenIds.add(e.id)
      return true
    }),
  ]

  const result = buildSuggestion(candidates, RULES, DEFAULT_DOMAIN_CONFIG, {
    budget,
    pinned:     pinnedEntities,
    excluded:   Object.fromEntries(ENTITY_TYPES.map((t) => [t, excluded[t] ?? false])),
    blockedIds: new Set(blockedIds),
  })

  const simItems   = toSimItems(result.slots, DEFAULT_DOMAIN_CONFIG)
  const issues     = validateItems(simItems, RULES, DEFAULT_DOMAIN_CONFIG)
  const aggDetail  = aggregateDetailFor(simItems, RULES, DEFAULT_DOMAIN_CONFIG)

  const isValid    = simItems.length >= 2 && issues.filter((i) => i.severity === 'error').length === 0
  const bom        = isValid ? buildBom(result.slots, DEFAULT_DOMAIN_CONFIG) : []
  const cost       = totalCostOf(result.slots, DEFAULT_DOMAIN_CONFIG)

  return {
    slots:      result.slots,
    totalCost:  cost,
    issues,
    bom,
    isValid,
    aggregateDetail: aggDetail,
  }
})
