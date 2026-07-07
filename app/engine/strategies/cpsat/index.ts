/**
 * Exact MILP fill strategy. compile → solve → map back to slots.
 *
 * FillStrategy contract parity with backtrack: pinned slots are preserved
 * verbatim, excluded types stay empty, and on infeasibility the non-pinned
 * slots come back empty (validation then reports what is missing).
 */

import type { Entity } from '~/data/types'
import type { SlotItem } from '~/engine/engine-types'
import type { FillInput, FillStrategy } from '~/engine/strategies/types'
import { compileModel, type CpsatInput } from './compiler'
import { solveLp } from './highs'

export interface CpsatResult {
  status: 'optimal' | 'infeasible' | 'error'
  slots: Record<string, SlotItem[]>
  totalCost: number
  objectiveValue: number | null
  penaltyCost: number
  /** pick vars of the solved (non-pinned) part — used for top-K cuts */
  pickedVars: string[]
}

export async function cpsatSolve(input: CpsatInput): Promise<CpsatResult> {
  const { cfg } = input
  const costAttr = cfg.costAttribute
  const pinned = input.pinned ?? {}

  const baseSlots = (): Record<string, SlotItem[]> =>
    Object.fromEntries(cfg.entityTypes.map((t) => [t, (pinned[t] ?? []).map((s) => ({ ...s }))]))

  const pinnedCost = Object.values(pinned).flat()
    .reduce((s, i) => s + Number(i.entity.attributes[costAttr] ?? 0) * i.quantity, 0)

  const model = compileModel(input)
  if (model.infeasibleReason) {
    return { status: 'infeasible', slots: baseSlots(), totalCost: pinnedCost, objectiveValue: null, penaltyCost: 0, pickedVars: [] }
  }
  if (model.pickVarOf.size === 0) {
    return { status: 'optimal', slots: baseSlots(), totalCost: pinnedCost, objectiveValue: pinnedCost, penaltyCost: 0, pickedVars: [] }
  }

  const sol = await solveLp(model.lp, { timeLimitSec: input.timeLimitSec, mipRelGap: input.mipRelGap })
  if (sol.status !== 'Optimal') {
    return {
      status: sol.status === 'Infeasible' ? 'infeasible' : 'error',
      slots: baseSlots(), totalCost: pinnedCost, objectiveValue: null, penaltyCost: 0, pickedVars: [],
    }
  }

  const slots = baseSlots()
  const pickedVars: string[] = []
  let totalCost = pinnedCost
  for (const [yv, entity] of model.pickVarOf) {
    if ((sol.values[yv] ?? 0) < 0.5) continue
    pickedVars.push(yv)
    const qv = `q_${entity.id}`
    const quantity = model.qtyVarOf.has(qv) ? Math.round(sol.values[qv] ?? 1) : 1
    slots[entity.entity_type]!.push({ entity, quantity })
    totalCost += Number(entity.attributes[costAttr] ?? 0) * quantity
  }

  let penaltyCost = 0
  for (const [sv, weight] of model.slackPenalty) penaltyCost += weight * (sol.values[sv] ?? 0)

  const objective = input.objective ?? cfg.objective ?? { mode: 'min_cost' }
  const objectiveValue = objective.mode === 'min_cost' ? sol.objective + pinnedCost : sol.objective

  return { status: 'optimal', slots, totalCost, objectiveValue, penaltyCost, pickedVars }
}

export class CpsatFillStrategy implements FillStrategy {
  async fill({ entities, cfg, budget, pinned, excluded }: FillInput): Promise<Record<string, SlotItem[]>> {
    const result = await cpsatSolve({
      cfg,
      entities,
      budget: Number.isFinite(budget) ? budget : null,
      pinned,
      excluded,
    })
    if (result.status !== 'optimal') {
      console.error(`[cpsat] solve status: ${result.status} — returning pinned-only slots`)
    }
    return result.slots
  }
}

export type { CpsatInput, Entity }
