/**
 * Infeasibility explanation by single-relaxation probing: which ONE
 * relaxation (raise budget, or drop one hard rule) restores feasibility.
 * Returns 'budget' and/or rule codes, ordered as probed.
 */

import type { MilpInput } from './compiler'
import { milpSolve } from './index'

export async function explainInfeasible(input: MilpInput): Promise<string[]> {
  const base = await milpSolve(input)
  if (base.status === 'optimal') return []

  const hints: string[] = []

  if (input.budget !== null && Number.isFinite(input.budget)) {
    const r = await milpSolve({ ...input, skipBudget: true })
    if (r.status === 'optimal') hints.push('budget')
  }

  const hardRules = input.cfg.rules.filter((r) => r.is_active && r.severity === 'error')
  for (const rule of hardRules) {
    const r = await milpSolve({ ...input, skipRuleIds: new Set([rule.id]) })
    if (r.status === 'optimal') hints.push(rule.code)
  }

  return hints
}
