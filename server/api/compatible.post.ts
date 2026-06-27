import { runPairwise } from '~/engine/pairwise'
import { DOMAIN } from '~/domains'
import { fetchPickerCandidates, fetchByIds, dbConfigFrom } from '../utils/db'
import { parseBudget, parseEntityType, parseBlockedIds, parseLookupIds } from '../utils/validate'
import type { Entity } from '~/data/types'

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event)

  const type             = parseEntityType(body.type, DOMAIN.entityTypes)
  const currentEntityIds = parseLookupIds(body.currentEntityIds)
  const blockedIds       = parseBlockedIds(body.blockedIds)

  const DB = event.context.cloudflare?.env?.DB
  if (!DB) throw createError({ statusCode: 503, message: 'D1 database not available' })

  const dbCfg = dbConfigFrom(DOMAIN)

  const contextEntities: Entity[] = currentEntityIds.length > 0 ? await fetchByIds(DB, currentEntityIds, dbCfg) : []
  const pool: Entity[] = await fetchPickerCandidates(DB, type, 999_999_999, blockedIds, dbCfg)

  const errorRules = DOMAIN.rules.filter((r) => r.is_active && r.check_type === 'pairwise' && r.severity === 'error')
  const compatible = pool.filter((candidate) =>
    errorRules.every((rule) =>
      contextEntities.every((other) =>
        runPairwise(rule, [candidate, other]).length === 0
      )
    )
  )

  return compatible
})
