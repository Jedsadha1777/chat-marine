// workerd PoC: proves the full cpsat path (compiler + HiGHS WASM) runs
// inside the CF Pages runtime — toy LP + the real marine-power domain.
import marineCfg from '~/domains/marine-power.json'
import marineEntities from '../../test/fixtures/marine-power.entities.json'
import type { Entity } from '~/data/types'
import type { DomainConfig } from '~/engine/engine-types'

export default defineEventHandler(async () => {
  const t0 = Date.now()
  try {
    const { solveLp } = await import('~/engine/strategies/cpsat/highs')
    const toy = await solveLp('Minimize\n obj: 3 x + 5 y\nSubject To\n c1: x + y >= 1\nBinary\n x y\nEnd')

    const { cpsatSolve } = await import('~/engine/strategies/cpsat/index')
    const marine = await cpsatSolve({
      cfg: marineCfg as unknown as DomainConfig,
      entities: marineEntities as unknown as Entity[],
      budget: 60000,
    })
    return {
      ok: toy.status === 'Optimal' && marine.status === 'optimal',
      toy: toy.status,
      marine: {
        status: marine.status,
        totalCost: marine.totalCost,
        config: Object.entries(marine.slots)
          .map(([t, s]) => (s[0] ? `${t}=${s[0].entity.code}x${s[0].quantity}` : ''))
          .filter(Boolean),
      },
      ms: Date.now() - t0,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 }
  }
})
