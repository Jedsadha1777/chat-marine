/**
 * RuleFlow layer coverage — tokenizer/parser, evalExpr, prepareModule, evalModule
 * (formula + if-blocks), and the budgetPlan integration path through the engine.
 */

import type { Entity } from '~/data/types'
import type { Module, PreparedModule } from '~/engine/ruleflow/index'
import type { IfBlock, FormulaBlock } from '~/engine/ruleflow/types'
import { prepareModule, evalModule } from '~/engine/ruleflow/index'
import { evalExpr } from '~/engine/ruleflow/eval'
import { parseExpr } from '~/engine/ruleflow/parser'
import { ConfigError, InputError, RunError } from '~/engine/ruleflow/errors'
import { buildSuggestion } from '~/engine/suggest'
import { DOMAIN } from '~/domains'

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

function ev(src: string, ctx: Record<string, unknown> = {}): unknown {
  return evalExpr(parseExpr(src), ctx)
}

function throws(fn: () => unknown, match: { name?: string; code?: string; msg?: string }): boolean {
  try { fn(); return false }
  catch (e) {
    const err = e as Error & { code?: string }
    if (match.name && err.name !== match.name) return false
    if (match.code && err.code !== match.code) return false
    if (match.msg && !err.message.includes(match.msg)) return false
    return true
  }
}

// ── parser + evalExpr ─────────────────────────────────────────────────────────

console.log('\n── expression: precedence + literals ──')

assert(ev('2 + 3 * 4') === 14, 'precedence: * before +')
assert(ev('(2 + 3) * 4') === 20, 'parens override precedence')
assert(ev('2 ** 3 ** 2') === 512, '** is right-associative')
assert(ev('-2 ** 2') === -4, 'unary minus binds looser than ** (like Python)')
assert(ev('10 / 4') === 2.5, 'division')
assert(ev('10 % 3') === 1, 'modulo')
assert(ev("'a\\nb'") === 'a\nb', 'string escape \\n')
assert(ev('null') === null, 'null literal')
assert(ev('true') === true && ev('false') === false, 'bool literals')

console.log('\n── expression: built-in functions ──')

assert(ev('round(2.5)') === 3, 'round')
assert(ev('ceil(2.1)') === 3, 'ceil')
assert(ev('floor(2.9)') === 2, 'floor')
assert(ev('min(3, 1, 2)') === 1, 'min (n-ary)')
assert(ev('max(3, 1, 2)') === 3, 'max (n-ary)')
assert(ev('abs(-5)') === 5, 'abs')
assert(ev('clamp(15, 0, 10)') === 10 && ev('clamp(-5, 0, 10)') === 0, 'clamp')
assert(ev('pow(2, 10)') === 1024, 'pow')
assert(ev('sqrt(16)') === 4, 'sqrt')

console.log('\n── expression: comparison + logic ──')

assert(ev('$a > $b', { a: 5, b: 3 }) === true, 'cmp vars')
assert(ev("'apple' == 'apple'") === true, 'string equality')
assert(ev('$a == 5', { a: '5' }) === true, 'mixed str/num cmp coerces to number')
assert(ev('1 < 2 AND 2 < 3') === true, 'AND')
assert(ev('1 > 2 OR 2 < 3') === true, 'OR')
assert(ev('NOT true') === false, 'NOT')
assert(ev('!$flag', { flag: false }) === true, 'unary !')

const flat = parseExpr('$a AND $b AND $c')
assert(flat.k === 'logic' && flat.operands.length === 3, 'AND chain flattens to n-ary node')

console.log('\n── expression: errors ──')

assert(throws(() => ev('1 / 0'), { name: 'RunError', code: 'R2_DIVIDE_BY_ZERO' }), 'divide by zero → RunError')
assert(throws(() => ev('1 % 0'), { name: 'RunError', code: 'R2_DIVIDE_BY_ZERO' }), 'modulo by zero → RunError')
assert(throws(() => ev('nope(1)'), { name: 'RunError', code: 'R2_UNKNOWN_FUNC' }), 'unknown function → RunError')
assert(throws(() => ev('$missing'), { name: 'RunError', code: 'R2_UNDEFINED_VAR' }), 'undefined var → RunError')
assert(throws(() => parseExpr('foo'), { name: 'ConfigError', code: 'S5_EXPR_PARSE' }), 'bare identifier → ConfigError')
assert(throws(() => parseExpr("'abc"), { msg: 'unterminated' }), 'unterminated string → TokenizeError')
assert(throws(() => parseExpr('2 @ 3'), { msg: 'unexpected character' }), 'unknown char → TokenizeError')
assert(throws(() => parseExpr('2 3'), { name: 'ConfigError', code: 'S5_EXPR_PARSE' }), 'trailing token → ConfigError')

// ── prepareModule ─────────────────────────────────────────────────────────────

console.log('\n── prepareModule: ordering + validation ──')

const outOfOrder: Module = {
  name: 'ooo', ver: '1',
  inputs: [{ name: 'base', type: 'num' }],
  outputs: ['y'],
  blocks: [
    { id: 'b', out: ['y', 'num'], expr: '$x * 2' } as FormulaBlock,
    { id: 'a', out: ['x', 'num'], expr: '$base + 1' } as FormulaBlock,
  ],
}
assert(evalModule(prepareModule(outOfOrder), { base: 4 })['y'] === 10, 'blocks reordered by dependency (b needs a)')

const cyclic: Module = {
  name: 'cyc', ver: '1', inputs: [], outputs: ['x'],
  blocks: [
    { id: 'a', out: ['x', 'num'], expr: '$y' } as FormulaBlock,
    { id: 'b', out: ['y', 'num'], expr: '$x' } as FormulaBlock,
  ],
}
assert(throws(() => prepareModule(cyclic), { name: 'ConfigError', code: 'S4_CYCLE' }), 'cycle → ConfigError S4_CYCLE')

const badPayload: Module = {
  name: 'bad', ver: '1', inputs: [{ name: 'n', type: 'num' }], outputs: ['ratio'],
  blocks: [{
    id: 'tier', outs: [['ratio', 'num', 0.5]],
    branches: [['$n > 0', { zzz: 1 }]],
    else: { ratio: 0.5 },
  } as IfBlock],
}
assert(throws(() => prepareModule(badPayload), { name: 'ConfigError', code: 'S6_UNKNOWN_OUTPUT' }), 'payload sets undeclared output → ConfigError')

// ── evalModule: input validation ──────────────────────────────────────────────

console.log('\n── evalModule: inputs ──')

const oneInput = (decl: object): PreparedModule => prepareModule({
  name: 'i', ver: '1', inputs: [{ name: 'a', type: 'num', ...decl }],
  outputs: ['y'], blocks: [{ id: 'f', out: ['y', 'num'], expr: '1 + 1' } as FormulaBlock],
})

assert(throws(() => evalModule(oneInput({}), {}), { name: 'InputError', code: 'R1_MISSING_REQUIRED' }), 'missing required input → InputError')
assert(evalModule(oneInput({ nullable: true }), {})['y'] === 2, 'nullable input may be omitted')
assert(throws(() => evalModule(oneInput({ min: 0 }), { a: -1 }), { name: 'InputError', code: 'R1_OUT_OF_RANGE' }), 'below min → InputError')
assert(throws(() => evalModule(oneInput({ max: 10 }), { a: 11 }), { name: 'InputError', code: 'R1_OUT_OF_RANGE' }), 'above max → InputError')
assert(throws(() => evalModule(oneInput({}), { a: 'abc' }), { name: 'InputError', code: 'R1_TYPE_MISMATCH' }), 'non-numeric for num → InputError')

const coerces = prepareModule({
  name: 'c', ver: '1', inputs: [{ name: 'a', type: 'num' }],
  outputs: ['y'], blocks: [{ id: 'f', out: ['y', 'num'], expr: '$a * 2' } as FormulaBlock],
})
assert(evalModule(coerces, { a: '5' })['y'] === 10, "numeric string input coerced ('5' → 5)")

// ── evalModule: if-blocks ─────────────────────────────────────────────────────

console.log('\n── evalModule: if-blocks ──')

const tierBlock: IfBlock = {
  id: 'tier',
  outs: [['ratio', 'num', 0.5], ['label', 'str', 'base']],
  branches: [
    ['$budget >= 80000', { ratio: 0.6, label: 'high' }],
    ['$budget >= 40000', { ratio: 0.55 }],
  ],
  else: { ratio: 0.45, label: 'low' },
}
const tiered = prepareModule({
  name: 'tiered', ver: '1',
  inputs: [{ name: 'budget', type: 'num' }],
  outputs: ['ratio', 'label'],
  blocks: [tierBlock],
})

const hi = evalModule(tiered, { budget: 100000 })
assert(hi['ratio'] === 0.6 && hi['label'] === 'high', 'first matching branch wins')
const mid = evalModule(tiered, { budget: 50000 })
assert(mid['ratio'] === 0.55, 'second branch matches when first fails')
assert(mid['label'] === 'base', 'outputs not set by branch keep their fallback')
const lo = evalModule(tiered, { budget: 10000 })
assert(lo['ratio'] === 0.45 && lo['label'] === 'low', 'else payload applies when no branch matches')

const exprPayload = prepareModule({
  name: 'ep', ver: '1', inputs: [{ name: 'budget', type: 'num' }], outputs: ['ratio'],
  blocks: [{
    id: 'tier', outs: [['ratio', 'num', 0]],
    branches: [['$budget > 0', { ratio: '$budget / 100000' }]],
    else: { ratio: 0 },
  } as IfBlock],
})
assert(evalModule(exprPayload, { budget: 60000 })['ratio'] === 0.6, 'string payload value parsed and evaluated as expression')

const nestedBlocks = prepareModule({
  name: 'nb', ver: '1', inputs: [{ name: 'budget', type: 'num' }], outputs: ['half'],
  blocks: [{
    id: 'outer', outs: [['half', 'num', 0]],
    branches: [['$budget > 0', [{ id: 'inner', out: ['half', 'num'], expr: '$budget / 2' } as FormulaBlock]]],
    else: { half: 0 },
  } as IfBlock],
})
assert(evalModule(nestedBlocks, { budget: 30000 })['half'] === 15000, 'nested-blocks payload executes formula blocks')

console.log('\n── evalModule: runtime errors ──')

const missingOut = prepareModule({
  name: 'mo', ver: '1', inputs: [], outputs: ['y', 'z'],
  blocks: [{ id: 'f', out: ['y', 'num'], expr: '1' } as FormulaBlock],
})
assert(throws(() => evalModule(missingOut, {}), { name: 'RunError', code: 'R2_OUTPUT_MISSING' }), 'declared output never produced → RunError')

try {
  evalModule(prepareModule({
    name: 'loc', ver: '1', inputs: [{ name: 'a', type: 'num' }], outputs: ['y'],
    blocks: [{ id: 'boom', out: ['y', 'num'], expr: '$a / 0' } as FormulaBlock],
  }), { a: 1 })
  assert(false, 'RunError carries failing block id', 'did not throw')
} catch (e) {
  assert(e instanceof RunError && e.loc?.block === 'boom', 'RunError carries failing block id', `got ${(e as RunError).loc?.block}`)
}

// ── integration: budgetPlan through the engine ────────────────────────────────

console.log('\n── integration: budgetPlan → buildSuggestion ──')

const POOL: Entity[] = [
  { id: 1, uuid: 'g', entity_type: 'gpu', code: 'G', name: 'GPU', status: 'published', attributes: { power_draw_w: 200, unit_cost: 10000 } },
  { id: 2, uuid: 'c', entity_type: 'cpu', code: 'C', name: 'CPU', status: 'published', attributes: { socket: 'X', tdp_w: 65, unit_cost: 5000 } },
  { id: 3, uuid: 'm', entity_type: 'motherboard', code: 'M', name: 'MB', status: 'published', attributes: { socket: 'X', ram_type: 'DDR5', ram_slots: 4, power_draw_w: 50, unit_cost: 4000 } },
  { id: 4, uuid: 'r', entity_type: 'ram', code: 'R', name: 'RAM', status: 'published', attributes: { ram_type: 'DDR5', modules: 2, capacity_gb: 32, power_draw_w: 10, unit_cost: 3000 } },
  { id: 5, uuid: 'p', entity_type: 'psu', code: 'P', name: 'PSU', status: 'published', attributes: { watt_output: 800, unit_cost: 3000 } },
]

const ifBlockPlan: Module = {
  name: 'tiered-anchor', ver: '1',
  inputs: [{ name: 'effectiveBudget', type: 'num' }, { name: 'entityCount', type: 'num' }],
  outputs: ['anchorTarget'],
  blocks: [
    {
      id: 'tier', outs: [['ratio', 'num', 0.5]],
      branches: [['$effectiveBudget >= 80000', { ratio: 0.6 }]],
      else: { ratio: 0.5 },
    } as IfBlock,
    { id: 'anchor', out: ['anchorTarget', 'num'], expr: 'round($effectiveBudget * $ratio)' } as FormulaBlock,
  ],
}
const ifCfg = { ...DOMAIN, budgetPlan: ifBlockPlan }
const ifResult = buildSuggestion(POOL, ifCfg, { budget: 30000 })
assert((ifResult.slots['gpu'] ?? []).length > 0, 'if-block budgetPlan: engine fills anchor through real path')

const brokenPlan: Module = {
  name: 'broken', ver: '1',
  inputs: [{ name: 'effectiveBudget', type: 'num' }, { name: 'entityCount', type: 'num' }],
  outputs: ['anchorTarget'],
  blocks: [{ id: 'a', out: ['anchorTarget', 'num'], expr: 'this is not valid (' } as FormulaBlock],
}
const brokenCfg = { ...DOMAIN, budgetPlan: brokenPlan }
let brokenOk = false
try {
  const r = buildSuggestion(POOL, brokenCfg, { budget: 30000 })
  brokenOk = (r.slots['gpu'] ?? []).length > 0
} catch { brokenOk = false }
assert(brokenOk, 'malformed budgetPlan: falls back to default target instead of throwing')

const nanPlan: Module = {
  name: 'nan', ver: '1',
  inputs: [{ name: 'effectiveBudget', type: 'num' }, { name: 'entityCount', type: 'num' }],
  outputs: ['anchorTarget'],
  blocks: [{ id: 'a', out: ['anchorTarget', 'num'], expr: 'sqrt(0 - 1)' } as FormulaBlock],
}
const nanCfg = { ...DOMAIN, budgetPlan: nanPlan }
let nanOk = false
try {
  const r = buildSuggestion(POOL, nanCfg, { budget: 30000 })
  nanOk = (r.slots['gpu'] ?? []).length > 0
} catch { nanOk = false }
assert(nanOk, 'NaN budgetPlan output: falls back to default target instead of propagating NaN')

// ── summary ───────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════')
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
