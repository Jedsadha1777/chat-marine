import { runPairwise } from '~/engine/pairwise'
import { RULES } from '~/data/rules'
import { fetchCandidates, fetchByIds } from '../utils/db'
import type { Entity } from '~/data/types'

interface CompatibleRequest {
  type: string
  budget: number | null
  currentEntityIds: number[]
  blockedIds: number[]
}

export default defineEventHandler(async (event) => {
  const body = await readBody<CompatibleRequest>(event)
  const { type, budget, currentEntityIds, blockedIds } = body

  const DB = event.context.cloudflare?.env?.DB
  if (!DB) throw createError({ statusCode: 503, message: 'D1 database not available' })

  const maxCost = budget ?? 999_999_999

  const contextEntities: Entity[] = currentEntityIds.length > 0 ? await fetchByIds(DB, currentEntityIds) : []
  const pool: Entity[] = await fetchCandidates(DB, type, maxCost, blockedIds, 30)

  const errorRules = RULES.filter((r) => r.is_active && r.check_type === 'pairwise' && r.severity === 'error')
  const compatible = pool.filter((candidate) =>
    errorRules.every((rule) =>
      contextEntities.every((other) =>
        runPairwise(rule, [candidate, other]).length === 0
      )
    )
  )

  return compatible
})
