/**
 * Exact fill strategy: compile → solve → map solution back to slots.
 * Async by design (solver graduation will require an async FillStrategy).
 */

import type { Entity } from '~/data/types'
import type { DomainConfig, SlotItem } from '~/engine/suggest'
import { compileModel, type Objective } from './model-compiler'
import { solveLp } from './adapters/highs'

export interface CpsatResult {
  status: 'optimal' | 'infeasible' | 'error'
  slots: Record<string, SlotItem[]>
  totalCost: number
  objectiveValue: number | null
}

export async function cpsatFill(
  cfg: DomainConfig,
  entities: Entity[],
  budget: number | null,
  objective: Objective,
): Promise<CpsatResult> {
  const model = compileModel({ cfg, entities, budget, objective })
  const sol = await solveLp(model.lp)

  if (sol.status !== 'Optimal') {
    return {
      status: sol.status === 'Infeasible' ? 'infeasible' : 'error',
      slots: {},
      totalCost: 0,
      objectiveValue: null,
    }
  }

  const slots: Record<string, SlotItem[]> = Object.fromEntries(cfg.entityTypes.map((t) => [t, []]))
  let totalCost = 0

  for (const [yv, entity] of model.pickVarOf) {
    if ((sol.values[yv] ?? 0) < 0.5) continue
    const qv = `q_${entity.id}`
    const quantity = model.qtyVarOf.has(qv) ? Math.round(sol.values[qv] ?? 1) : 1
    slots[entity.entity_type]!.push({ entity, quantity })
    totalCost += Number(entity.attributes[cfg.costAttribute] ?? 0) * quantity
  }

  return { status: 'optimal', slots, totalCost, objectiveValue: sol.objective }
}
