/**
 * CP-SAT lab — marine-power domain solved exactly via MILP (HiGHS).
 * Proves capabilities the greedy engine structurally cannot provide:
 * quantity sizing, multi-dimensional capacity, real objective, infeasibility proof.
 *
 * Lab only — solver/ is never imported by app/ or server/, so it never deploys to CF.
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { Entity } from '~/data/types'
import type { DomainConfig } from '~/engine/suggest'
import { validateItems, toSimItems } from '~/engine/suggest'
import { compileModel } from '../solver/model-compiler'
import { cpsatFill } from '../solver/cpsat-strategy'

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

// ── load domain ───────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CFG = JSON.parse(readFileSync(join(ROOT, 'solver/domains/marine-power.json'), 'utf-8')) as DomainConfig
const ENTITIES = JSON.parse(readFileSync(join(ROOT, 'solver/domains/marine-power.entities.json'), 'utf-8')) as Entity[]

console.log('\n── domain sanity ──')
assert(CFG.entityTypes.length === 4, 'domain has 4 entity types')
assert(CFG.rules.length === 8, 'domain has 8 rules')
assert(ENTITIES.length === 44, '44 entities loaded')

// ── compiler smoke ────────────────────────────────────────────────────────────

console.log('\n── compiler smoke ──')
const model = compileModel({ cfg: CFG, entities: ENTITIES, budget: 60000, objective: { mode: 'min_cost' } })
assert(model.lp.includes('req_battery'), 'LP has one-hot row for battery type')
assert(model.lp.includes('budget:'), 'LP has budget row')
assert(model.lp.includes('Binary'), 'LP declares binary pick vars')
assert(model.lp.includes('General'), 'LP declares integer qty vars')

// ── solve @60k: feasible, valid, within budget ────────────────────────────────

console.log('\n── solve @60,000 (min_cost) ──')
const r60 = await cpsatFill(CFG, ENTITIES, 60000, { mode: 'min_cost' })
assert(r60.status === 'optimal', 'status optimal @60k', `got ${r60.status}`)
assert(r60.totalCost <= 60000, 'total cost within budget', `got ${r60.totalCost}`)

const simItems = toSimItems(r60.slots, CFG)
const issues = validateItems(simItems, CFG)
const errorIssues = issues.filter((i) => i.severity === 'error')
assert(errorIssues.length === 0, 'production validateItems reports ZERO error issues',
  errorIssues.map((i) => i.rule_code).join(','))

const qty = (t: string): number => (r60.slots[t] ?? []).reduce((s, i) => s + i.quantity, 0)
assert(qty('battery') >= 1 && qty('battery') <= 8, 'battery qty within 1..8', `got ${qty('battery')}`)
assert(qty('solar_panel') >= 1 && qty('solar_panel') <= 6, 'solar qty within 1..6', `got ${qty('solar_panel')}`)
assert(qty('inverter') === 1 && qty('charge_controller') === 1, 'inverter and controller exactly 1')

const bat = r60.slots['battery']?.[0]?.entity
const ctl = r60.slots['charge_controller']?.[0]?.entity
const inv = r60.slots['inverter']?.[0]?.entity
assert(
  Array.isArray(ctl?.attributes['supports_chemistry']) &&
  (ctl!.attributes['supports_chemistry'] as string[]).includes(String(bat?.attributes['chemistry'])),
  'controller supports chosen battery chemistry',
)
assert(inv?.attributes['input_voltage'] === bat?.attributes['voltage'], 'inverter voltage matches battery bank')

const sumAttr = (t: string, attr: string): number =>
  (r60.slots[t] ?? []).reduce((s, i) => s + Number(i.entity.attributes[attr] ?? 0) * i.quantity, 0)
assert(sumAttr('solar_panel', 'area_m2') <= 4.0, 'deck area within 4.0 m²', `got ${sumAttr('solar_panel', 'area_m2')}`)
assert(sumAttr('battery', 'weight_kg') + sumAttr('solar_panel', 'weight_kg') <= 160, 'weight within 160 kg',
  `got ${sumAttr('battery', 'weight_kg') + sumAttr('solar_panel', 'weight_kg')}`)

console.log(`   → config: ${Object.entries(r60.slots).map(([t, s]) => s[0] ? `${t}=${s[0].entity.code}×${s[0].quantity}` : '').filter(Boolean).join(' | ')} — total ${r60.totalCost}`)

// ── infeasibility proof @45k ──────────────────────────────────────────────────

console.log('\n── solve @45,000: infeasible proof ──')
const r45 = await cpsatFill(CFG, ENTITIES, 45000, { mode: 'min_cost' })
assert(r45.status === 'infeasible', 'solver PROVES 45k is infeasible (greedy can never do this)', `got ${r45.status}`)

// ── optimality: min cost is budget-independent once feasible ──────────────────

console.log('\n── min-cost stability ──')
const r100 = await cpsatFill(CFG, ENTITIES, 100000, { mode: 'min_cost' })
assert(r100.status === 'optimal', 'status optimal @100k')
assert(r100.totalCost === r60.totalCost, 'min cost @100k equals min cost @60k (true optimum)',
  `${r100.totalCost} vs ${r60.totalCost}`)

// ── objective swap: maximize usable_ah within budget ──────────────────────────

console.log('\n── objective swap: max usable_ah @100,000 ──')
const rMax = await cpsatFill(CFG, ENTITIES, 100000, { mode: 'max_attribute', type: 'battery', attribute: 'usable_ah' })
assert(rMax.status === 'optimal', 'status optimal (max_attribute)')
assert(rMax.totalCost <= 100000, 'max-usable config within budget', `got ${rMax.totalCost}`)
const usableOf = (r: typeof r60): number =>
  (r.slots['battery'] ?? []).reduce((s, i) => s + Number(i.entity.attributes['usable_ah'] ?? 0) * i.quantity, 0)
assert(usableOf(rMax) > usableOf(r60), 'max-usable objective beats min-cost on usable Ah',
  `${usableOf(rMax)} vs ${usableOf(r60)}`)
const maxIssues = validateItems(toSimItems(rMax.slots, CFG), CFG).filter((i) => i.severity === 'error')
assert(maxIssues.length === 0, 'max-usable config also passes all error rules', maxIssues.map((i) => i.rule_code).join(','))

console.log(`   → min_cost usable=${usableOf(r60)}Ah (${r60.totalCost}) vs max_attribute usable=${usableOf(rMax)}Ah (${rMax.totalCost})`)

// ── summary ───────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════')
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
