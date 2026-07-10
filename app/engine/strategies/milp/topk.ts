/**
 * Top-K distinct solutions via no-good cuts: after each solve, forbid the
 * exact pick set (Σ picked y ≤ n−1) and re-solve.
 */

import type { MilpInput } from './compiler'
import { milpSolve, type MilpResult } from './index'

export async function solveTopK(input: MilpInput, k: number): Promise<MilpResult[]> {
  const out: MilpResult[] = []
  const cuts: string[] = []

  for (let i = 0; i < k; i++) {
    const r = await milpSolve({ ...input, extraRows: [...cuts] })
    if (r.status !== 'optimal') break
    out.push(r)
    if (r.pickedVars.length === 0) break
    const terms = r.pickedVars.map((v) => `1 ${v}`).join(' + ')
    cuts.push(` cut_${i}: ${terms} <= ${r.pickedVars.length - 1}`)
  }
  return out
}
