import { buildSuggestion, validateItems, aggregateDetailFor, buildBom, totalCostOf, toSimItems } from '~/engine/suggest'
import { RULES } from '~/data/rules'
import { DEFAULT_DOMAIN_CONFIG } from '~/composables/domainConfig'
import { ENTITY_TYPES } from '~/data/entityTypes'
import { fetchCandidates, fetchByIds } from '../utils/db'
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

  // Fetch top-15 candidates per type — 5 D1 queries in parallel
  // 5 types × 15 rows = 75 rows per request (well within 5M/day free limit)
  const results = await Promise.all(
    ENTITY_TYPES.map((type) => {
      if (excluded[type] || (pinnedEntities[type]?.length ?? 0) > 0) return Promise.resolve([] as Entity[])
      return fetchCandidates(DB, type, maxCost, blockedIds, 15)
    })
  )
  const candidates: Entity[] = [
    ...Object.values(pinnedEntities).flat().map((s) => s.entity),
    ...results.flat(),
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
