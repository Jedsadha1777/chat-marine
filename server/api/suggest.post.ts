import { buildSuggestion, validateItems, aggregateDetailFor, buildBom, totalCostOf, toSimItems } from '~/engine/suggest'
import { RULES } from '~/data/rules'
import { DEFAULT_DOMAIN_CONFIG } from '~/composables/simulationConfig'
import { ENTITY_TYPES } from '~/data/entityTypes'
import { fetchCandidates, fetchCheapestCandidates, fetchByIds } from '../utils/db'
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

  const pinnedCostTotal = Object.values(pinnedEntities)
    .flat()
    .reduce((sum, s) => sum + Number(s.entity.attributes.unit_cost ?? 0) * s.quantity, 0)
  const effectiveMax = budget !== null ? Math.max(0, budget - pinnedCostTotal) : 999_999_999

  const anchorType   = DEFAULT_DOMAIN_CONFIG.anchorType   ?? 'gpu'
  const capacityType = DEFAULT_DOMAIN_CONFIG.capacityType ?? 'psu'

  const coreTypes = ENTITY_TYPES.filter((t) => t !== anchorType && t !== capacityType)
  const coreFilledTypes = coreTypes.filter((t) =>
    !excluded[t] && (pinnedEntities[t]?.length ?? 0) === 0,
  )

  // Equal share of effectiveMax per slot — no hardcoded ratio numbers.
  const perSlot = coreFilledTypes.length > 0
    ? Math.round(effectiveMax / coreFilledTypes.length)
    : effectiveMax

  const [results, cheapResults] = await Promise.all([
    Promise.all(
      ENTITY_TYPES.map((type) => {
        if (excluded[type] || (pinnedEntities[type]?.length ?? 0) > 0) return Promise.resolve([] as Entity[])
        if (type === anchorType) return fetchCandidates(DB, type, effectiveMax, blockedIds, 60)
        if (type === capacityType) return fetchCandidates(DB, type, maxCost, blockedIds, 50)
        return fetchCandidates(DB, type, perSlot, blockedIds, 15)
      })
    ),
    Promise.all(
      coreFilledTypes.map((type) =>
        fetchCheapestCandidates(DB, type, perSlot, blockedIds, 10),
      )
    ),
  ])

  const seenIds = new Set<number>()
  const candidates: Entity[] = [
    ...Object.values(pinnedEntities).flat().map((s) => s.entity),
    ...[...results.flat(), ...cheapResults.flat()].filter((e) => {
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
