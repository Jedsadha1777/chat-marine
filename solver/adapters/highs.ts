/**
 * HiGHS (WASM) adapter — solves a CPLEX-LP string in Node.
 * Lazy-loads the WASM once per process.
 */

import highsLoader from 'highs'

export interface LpSolution {
  status: string
  objective: number
  values: Record<string, number>
}

type Highs = Awaited<ReturnType<typeof highsLoader>>
let _highs: Promise<Highs> | null = null

export async function solveLp(lp: string): Promise<LpSolution> {
  _highs ??= highsLoader()
  const h = await _highs
  const sol = h.solve(lp) as unknown as {
    Status: string
    ObjectiveValue: number
    Columns: Record<string, { Primal: number }>
  }
  const values: Record<string, number> = {}
  for (const [name, col] of Object.entries(sol.Columns ?? {})) values[name] = col.Primal
  return { status: String(sol.Status), objective: Number(sol.ObjectiveValue), values }
}
