import { buildSuggestion, validateItems, aggregateDetailFor, buildBom, totalCostOf, toSimItems } from '~/engine/suggest'
import type { SlotItem } from '~/engine/suggest'
import { DOMAIN } from '~/domains'
import { fetchForDomain, fetchByIds } from '../utils/fetchForDomain'
import { dbConfigFrom } from '../utils/db'
import { parseBudget, parsePinned } from '../utils/validate'

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event)

  const budget     = parseBudget(body.budget)
  const pinnedReq  = parsePinned(body.pinned, DOMAIN.entityTypes)
  const excluded   = (body.excluded && typeof body.excluded === 'object' && !Array.isArray(body.excluded))
    ? body.excluded as Record<string, boolean>
    : {}

  const DB = event.context.cloudflare?.env?.DB
  if (!DB) throw createError({ statusCode: 503, message: 'D1 database not available' })

  const dbCfg = dbConfigFrom(DOMAIN)
  const allPinnedIds = Object.values(pinnedReq).flat().map((p) => p.id)
  const pinnedById = new Map((await fetchByIds(DB, allPinnedIds, dbCfg)).map((e) => [e.id, e]))

  const pinnedEntities: Record<string, SlotItem[]> = Object.fromEntries(
    DOMAIN.entityTypes.map((type) => [
      type,
      (pinnedReq[type] ?? [])
        .map((p) => ({ entity: pinnedById.get(p.id)!, quantity: p.quantity }))
        .filter((s) => s.entity != null),
    ]),
  )

  const candidates = await fetchForDomain(DB, DOMAIN, { budget, pinnedEntities, excluded })

  const result = buildSuggestion(candidates, DOMAIN, {
    budget,
    pinned:   pinnedEntities,
    excluded: Object.fromEntries(DOMAIN.entityTypes.map((t) => [t, excluded[t] ?? false])),
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
