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
  _highs ??= loadHighs()
  return _highs
}

async function loadHighs(): Promise<HighsInstance> {
  const mod = await import('highs')
  const loader = mod.default as (opts?: Record<string, unknown>) => Promise<HighsInstance>
  try {
    return await loader()
  } catch {
    // workerd: the Emscripten glue cannot locate itself (no self.location) and
    // may not fetch the .wasm; CF also forbids compiling wasm from bytes.
    // Import the .wasm as a precompiled module and instantiate it ourselves.
    const g = globalThis as { location?: unknown; __dirname?: string; __filename?: string }
    g.location ??= { href: 'https://solver.local/' }
    g.__dirname ??= '/'
    g.__filename ??= '/highs.js'
    const wasmImport = await import('highs-wasm' as string)
    const wasmModule = (wasmImport.default ?? wasmImport) as WebAssembly.Module
    return await loader({
      instantiateWasm(imports: WebAssembly.Imports, cb: (i: WebAssembly.Instance) => void) {
        Promise.resolve(WebAssembly.instantiate(wasmModule, imports)).then((r) =>
          cb(r instanceof WebAssembly.Instance ? r : (r as WebAssembly.WebAssemblyInstantiatedSource).instance))
        return {}
      },
    })
  }
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
