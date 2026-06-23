import { buildSuggestion, validateItems, aggregateDetailFor, buildBom, totalCostOf, toSimItems } from '~/engine/suggest'
import type { SlotItem } from '~/engine/suggest'
import { DOMAIN } from '~/domains'
import { fetchForDomain, fetchByIds } from '../utils/fetchForDomain'

interface SuggestRequest {
  budget: number | null
  pinned: Record<string, Array<{ id: number; quantity: number }>>
  excluded: Record<string, boolean>
  blockedIds: number[]
}

export default defineEventHandler(async (event) => {
  const body = await readBody<SuggestRequest>(event)

  const budget: number | null = body.budget ?? null
  const pinnedReq             = body.pinned   ?? {}
  const excluded              = body.excluded  ?? {}
  const blockedIds: number[]  = body.blockedIds ?? []

  const DB = event.context.cloudflare?.env?.DB
  if (!DB) throw createError({ statusCode: 503, message: 'D1 database not available' })

  const allPinnedIds = Object.values(pinnedReq).flat().map((p) => p.id)
  const pinnedById = new Map((await fetchByIds(DB, allPinnedIds)).map((e) => [e.id, e]))

  const pinnedEntities: Record<string, SlotItem[]> = Object.fromEntries(
    DOMAIN.entityTypes.map((type) => [
      type,
      (pinnedReq[type] ?? [])
        .map((p) => ({ entity: pinnedById.get(p.id)!, quantity: p.quantity }))
        .filter((s) => s.entity != null),
    ]),
  )

  const candidates = await fetchForDomain(DB, DOMAIN, { budget, pinnedEntities, excluded, blockedIds })

  const result = buildSuggestion(candidates, DOMAIN, {
    budget,
    pinned:     pinnedEntities,
    excluded:   Object.fromEntries(DOMAIN.entityTypes.map((t) => [t, excluded[t] ?? false])),
    blockedIds: new Set(blockedIds),
  })

  const simItems  = toSimItems(result.slots, DOMAIN)
  const issues    = validateItems(simItems, DOMAIN)
  const aggDetail = aggregateDetailFor(simItems, DOMAIN)

  const isValid = simItems.length >= 2 && issues.filter((i) => i.severity === 'error').length === 0
  const bom     = isValid ? buildBom(result.slots, DOMAIN) : []
  const cost    = totalCostOf(result.slots, DOMAIN)

  return {
    slots:           result.slots,
    totalCost:       cost,
    issues,
    bom,
    isValid,
    aggregateDetail: aggDetail,
  }
})
