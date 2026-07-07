/**
 * cpsat strategy — engine-integrated exact MILP fill (HiGHS).
 *
 * Covers: registry wiring, FillStrategy/buildSuggestion end-to-end, pinned,
 * excluded, soft constraints (rule penalty), top-K alternatives, infeasibility
 * explanation, and a PC-domain smoke on real seed data.
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { Entity, CompatibilityRule } from '~/data/types'
import type { DomainConfig, SlotItem } from '~/engine/suggest'
import { validateItems, toSimItems, totalCostOf, buildSuggestion } from '~/engine/suggest'
import { getStrategy } from '~/engine/strategies/index'
import { CpsatFillStrategy, cpsatSolve } from '~/engine/strategies/cpsat/index'
import { compileModel } from '~/engine/strategies/cpsat/compiler'
import { solveTopK } from '~/engine/strategies/cpsat/topk'
import { explainInfeasible } from '~/engine/strategies/cpsat/explain'

// ── test harness ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    console.log(`✅ ${label}`)
    passed++
  } else {
    console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

// ── load marine domain ────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CFG = JSON.parse(readFileSync(join(ROOT, 'app/domains/marine-power.json'), 'utf-8')) as DomainConfig
const ENTITIES = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/marine-power.entities.json'), 'utf-8')) as Entity[]

const errorsOf = (slots: Record<string, SlotItem[]>): string[] =>
  validateItems(toSimItems(slots, CFG), CFG).filter((i) => i.severity === 'error').map((i) => i.rule_code)

const qtyOf = (slots: Record<string, SlotItem[]>, t: string): number =>
  (slots[t] ?? []).reduce((s, i) => s + i.quantity, 0)

const sumAttr = (slots: Record<string, SlotItem[]>, t: string, attr: string): number =>
  (slots[t] ?? []).reduce((s, i) => s + Number(i.entity.attributes[attr] ?? 0) * i.quantity, 0)

const weightOf = (slots: Record<string, SlotItem[]>): number =>
  sumAttr(slots, 'battery', 'weight_kg') + sumAttr(slots, 'solar_panel', 'weight_kg')

console.log('\n── domain sanity ──')
assert(CFG.fillStrategy === 'cpsat', 'marine domain declares fillStrategy cpsat')
assert(CFG.rules.length === 9, 'domain has 9 rules (8 hard + 1 soft)')
assert(ENTITIES.length === 44, '44 entities loaded')

// ── registry wiring ───────────────────────────────────────────────────────────

console.log('\n── registry ──')
assert(getStrategy('cpsat') instanceof CpsatFillStrategy, "getStrategy('cpsat') returns CpsatFillStrategy")

// ── compiler smoke ────────────────────────────────────────────────────────────

console.log('\n── compiler smoke ──')
const model = compileModel({ cfg: CFG, entities: ENTITIES, budget: 60000 })
assert(model.lp.includes('req_battery'), 'LP has one-hot row for battery type')
assert(model.lp.includes('budget:'), 'LP has budget row')
assert(model.lp.includes('General'), 'LP declares integer qty vars')
assert(model.lp.includes('s_9'), 'LP has slack var for the soft rule (penalty)')

// ── buildSuggestion end-to-end (registry path) @60k ───────────────────────────

console.log('\n── buildSuggestion end-to-end @60,000 ──')
const e2e = await buildSuggestion(ENTITIES, CFG, { budget: 60000 })
assert(errorsOf(e2e.slots).length === 0, 'engine path: zero error issues', errorsOf(e2e.slots).join(','))
assert(totalCostOf(e2e.slots, CFG) <= 60000, 'engine path: cost within budget', `got ${totalCostOf(e2e.slots, CFG)}`)
assert(qtyOf(e2e.slots, 'battery') >= 1 && qtyOf(e2e.slots, 'battery') <= 8, 'battery qty within 1..8')
assert(qtyOf(e2e.slots, 'inverter') === 1 && qtyOf(e2e.slots, 'charge_controller') === 1, 'inverter and controller exactly 1')

const bat = e2e.slots['battery']?.[0]?.entity
const ctl = e2e.slots['charge_controller']?.[0]?.entity
const inv = e2e.slots['inverter']?.[0]?.entity
assert(
  Array.isArray(ctl?.attributes['supports_chemistry']) &&
  (ctl!.attributes['supports_chemistry'] as string[]).includes(String(bat?.attributes['chemistry'])),
  'controller supports chosen battery chemistry',
)
assert(inv?.attributes['input_voltage'] === bat?.attributes['voltage'], 'inverter voltage matches battery bank')
assert(sumAttr(e2e.slots, 'solar_panel', 'area_m2') <= 4.0, 'deck area within 4.0 m²')
assert(weightOf(e2e.slots) <= 160, 'weight within hard 160 kg cap', `got ${weightOf(e2e.slots)}`)

console.log(`   → ${Object.entries(e2e.slots).map(([t, s]) => s[0] ? `${t}=${s[0].entity.code}×${s[0].quantity}` : '').filter(Boolean).join(' | ')} — total ${totalCostOf(e2e.slots, CFG)}`)

// ── soft constraint: objective accounting ─────────────────────────────────────

console.log('\n── soft constraint (penalty) ──')
const soft = await cpsatSolve({ cfg: CFG, entities: ENTITIES, budget: 80000 })
assert(soft.status === 'optimal', 'soft solve optimal @80k')
assert(Math.abs(soft.objectiveValue! - (soft.totalCost + soft.penaltyCost)) < 1e-6,
  'objectiveValue = totalCost + penaltyCost', `${soft.objectiveValue} vs ${soft.totalCost}+${soft.penaltyCost}`)
const softOver = Math.max(0, weightOf(soft.slots) - 120)
assert(Math.abs(soft.penaltyCost - 120 * softOver) < 1e-6,
  'penaltyCost = penalty × kg over comfort target', `${soft.penaltyCost} vs 120×${softOver}`)

const noSoftCfg: DomainConfig = { ...CFG, rules: CFG.rules.map((r) => r.code === 'AGG_WEIGHT_COMFORT' ? { ...r, is_active: false } : r) }
const noSoft = await cpsatSolve({ cfg: noSoftCfg, entities: ENTITIES, budget: 80000 })
assert(noSoft.totalCost <= soft.totalCost, 'pure cost without soft rule ≤ cost with soft rule')

const harshCfg: DomainConfig = { ...CFG, rules: CFG.rules.map((r) => r.code === 'AGG_WEIGHT_COMFORT' ? { ...r, penalty: 10000 } : r) }
const harsh = await cpsatSolve({ cfg: harshCfg, entities: ENTITIES, budget: 80000 })
assert(weightOf(harsh.slots) <= 120, 'harsh penalty forces config under comfort weight', `got ${weightOf(harsh.slots)}`)
assert(errorsOf(harsh.slots).length === 0, 'harsh-penalty config still passes all hard rules')

// ── pinned ────────────────────────────────────────────────────────────────────

console.log('\n── pinned battery bank ──')
const LFP300 = ENTITIES.find((e) => e.id === 1013)!
const pinnedRes = await cpsatSolve({
  cfg: CFG, entities: ENTITIES, budget: 100000,
  pinned: { battery: [{ entity: LFP300, quantity: 2 }] },
})
assert(pinnedRes.status === 'optimal', 'pinned solve optimal')
assert(pinnedRes.slots['battery']?.[0]?.entity.id === 1013 && pinnedRes.slots['battery']?.[0]?.quantity === 2,
  'pinned battery kept at exact quantity')
assert(errorsOf(pinnedRes.slots).length === 0, 'pinned config passes all hard rules', errorsOf(pinnedRes.slots).join(','))
const pinnedCtl = pinnedRes.slots['charge_controller']?.[0]?.entity
assert((pinnedCtl?.attributes['supports_chemistry'] as string[]).includes('lifepo4'),
  'controller chosen compatible with pinned LiFePO4 bank')

// ── excluded ──────────────────────────────────────────────────────────────────

console.log('\n── excluded inverter ──')
const noInvCfg: DomainConfig = { ...CFG, requiredTypes: ['battery', 'solar_panel', 'charge_controller'] }
const noInv = await cpsatSolve({
  cfg: noInvCfg, entities: ENTITIES, budget: 60000,
  excluded: { inverter: true },
})
assert(noInv.status === 'optimal', 'excluded solve optimal')
assert((noInv.slots['inverter'] ?? []).length === 0, 'no inverter in solution')
assert(validateItems(toSimItems(noInv.slots, noInvCfg), noInvCfg).filter((i) => i.severity === 'error').length === 0,
  'excluded config passes remaining rules')

// ── top-K alternatives ────────────────────────────────────────────────────────

console.log('\n── top-3 alternatives @60,000 ──')
const top3 = await solveTopK({ cfg: CFG, entities: ENTITIES, budget: 60000 }, 3)
assert(top3.length === 3, 'returns 3 solutions', `got ${top3.length}`)
assert(top3.every((r) => r.status === 'optimal'), 'all 3 optimal')
const sig = (r: typeof top3[number]): string =>
  Object.values(r.slots).flat().map((i) => `${i.entity.id}x${i.quantity}`).sort().join('|')
assert(new Set(top3.map(sig)).size === 3, 'all 3 solutions are distinct configs')
const objs = top3.map((r) => r.objectiveValue!)
assert(objs[0]! <= objs[1]! && objs[1]! <= objs[2]!, 'objective values non-decreasing', objs.join(' ≤ '))
assert(top3.every((r) => errorsOf(r.slots).length === 0), 'all 3 pass hard rules')
console.log(`   → objectives: ${objs.map((o) => Math.round(o!)).join(', ')}`)

// ── infeasibility explanation ─────────────────────────────────────────────────

console.log('\n── explain infeasible @45,000 ──')
const r45 = await cpsatSolve({ cfg: CFG, entities: ENTITIES, budget: 45000 })
assert(r45.status === 'infeasible', '45k proven infeasible')
const hints = await explainInfeasible({ cfg: CFG, entities: ENTITIES, budget: 45000 })
assert(hints.includes('budget'), "hints include 'budget' (raising it restores feasibility)", hints.join(','))
console.log(`   → relaxations that restore feasibility: ${hints.join(', ')}`)

// ── PC domain smoke on real seed data ─────────────────────────────────────────

console.log('\n── PC domain via cpsat (seed data) ──')
const PC = JSON.parse(readFileSync(join(ROOT, 'app/domains/pc-builder.json'), 'utf-8')) as DomainConfig

function loadSeed(): Entity[] {
  const content = readFileSync(join(ROOT, 'server/database/seed.sql'), 'utf-8')
  const out: Entity[] = []
  const rx = /^\((\d+),'([^']+)','([^']+)','([^']+)','([^']+)','([^']+)',([\d.]+),'(.+?)'\)[,;]?\s*$/gm
  let m: RegExpExecArray | null
  while ((m = rx.exec(content)) !== null) {
    const attrs = JSON.parse(m[8]!)
    attrs.unit_cost = parseFloat(m[7]!)
    out.push({ id: +m[1]!, uuid: m[2]!, entity_type: m[3]!, code: m[4]!, name: m[5]!, status: m[6] as Entity['status'], attributes: attrs })
  }
  return out
}
const seed = loadSeed()
const pcPool = PC.entityTypes.flatMap((t) =>
  seed.filter((e) => e.entity_type === t && e.status === 'published')
    .sort((a, b) => Number(a.attributes.unit_cost) - Number(b.attributes.unit_cost))
    .filter((_, i, arr) => i < 30 || i >= arr.length - 10),
)
const pcCfg: DomainConfig = { ...PC, fillStrategy: 'cpsat' }
const pc = await buildSuggestion(pcPool, pcCfg, { budget: 60000 })
const pcIssues = validateItems(toSimItems(pc.slots, pcCfg), pcCfg).filter((i) => i.severity === 'error')
assert(PC.requiredTypes.every((t) => (pc.slots[t] ?? []).length > 0), 'PC required types all present')
assert(totalCostOf(pc.slots, pcCfg) <= 60000, 'PC cost within budget', `got ${totalCostOf(pc.slots, pcCfg)}`)
assert(pcIssues.length === 0, 'PC config passes all error rules (socket/ram/power…)', pcIssues.map((i) => i.rule_code).join(','))
console.log(`   → ${Object.entries(pc.slots).map(([t, s]) => s[0] ? `${t}=${s[0].entity.name.slice(0, 18)}` : '').filter(Boolean).join(' | ')} — total ${totalCostOf(pc.slots, pcCfg)}`)

// ── summary ───────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════')
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
