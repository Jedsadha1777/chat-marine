/**
 * Top-K distinct solutions via no-good cuts: after each solve, forbid the
 * exact pick set (Σ picked y ≤ n−1) and re-solve.
 */

import type { CpsatInput } from './compiler'
import { cpsatSolve, type CpsatResult } from './index'

export async function solveTopK(input: CpsatInput, k: number): Promise<CpsatResult[]> {
  const out: CpsatResult[] = []
  const cuts: string[] = []

  for (let i = 0; i < k; i++) {
    const r = await cpsatSolve({ ...input, extraRows: [...cuts] })
    if (r.status !== 'optimal') break
    out.push(r)
    if (r.pickedVars.length === 0) break
    const terms = r.pickedVars.map((v) => `1 ${v}`).join(' + ')
    cuts.push(` cut_${i}: ${terms} <= ${r.pickedVars.length - 1}`)
  }
  return out
}
