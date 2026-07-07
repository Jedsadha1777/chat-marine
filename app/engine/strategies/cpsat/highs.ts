/**
 * HiGHS (WASM) adapter. Loaded lazily via dynamic import so the solver
 * chunk is only pulled in when the cpsat strategy actually runs.
 */

export interface SolveOptions {
  timeLimitSec?: number
  mipRelGap?: number
}

export interface LpSolution {
  status: string
  objective: number
  values: Record<string, number>
}

interface HighsInstance {
  solve(lp: string, options?: Record<string, number>): {
    Status: string
    ObjectiveValue: number
    Columns: Record<string, { Primal: number }>
  }
}

let _highs: Promise<HighsInstance> | null = null

async function getHighs(): Promise<HighsInstance> {
  _highs ??= import('highs').then((m) => m.default() as Promise<HighsInstance>)
  return _highs
}

export async function solveLp(lp: string, opts: SolveOptions = {}): Promise<LpSolution> {
  const h = await getHighs()
  const options: Record<string, number> = {}
  if (opts.timeLimitSec !== undefined) options['time_limit'] = opts.timeLimitSec
  if (opts.mipRelGap !== undefined) options['mip_rel_gap'] = opts.mipRelGap

  const sol = h.solve(lp, options)
  const values: Record<string, number> = {}
  for (const [name, col] of Object.entries(sol.Columns ?? {})) values[name] = col.Primal
  return { status: String(sol.Status), objective: Number(sol.ObjectiveValue), values }
}
