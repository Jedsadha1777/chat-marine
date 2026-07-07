import type {
  AstNode, Block, FormulaBlock, IfBlock,
  Inputs, Module, Outputs, Payload,
  PreparedBlock, PreparedIf,
  PreparedModule, PreparedOut, PreparedPayload,
  PreparedSetEntry, PreparedValue, PrimType,
} from './types'
import { ConfigError, InputError, RunError } from './errors'
import { collectVarRefs, parseExpr } from './parser'

// ── Function registry ─────────────────────────────────────────────────────────

type FnImpl = (...args: unknown[]) => unknown
const _fns = new Map<string, FnImpl>()

export function registerFn(name: string, impl: FnImpl): void { _fns.set(name, impl) }

// Built-in math — registered immediately so any import of eval.ts has them available
registerFn('round',  (...a) => Math.round(Number(a[0])))
registerFn('ceil',   (...a) => Math.ceil(Number(a[0])))
registerFn('floor',  (...a) => Math.floor(Number(a[0])))
registerFn('min',    (...a) => Math.min(...a.map(Number)))
registerFn('max',    (...a) => Math.max(...a.map(Number)))
registerFn('abs',    (...a) => Math.abs(Number(a[0])))
registerFn('clamp',  (...a) => Math.max(Number(a[1]), Math.min(Number(a[2]), Number(a[0]))))
registerFn('pow',    (...a) => Math.pow(Number(a[0]), Number(a[1])))
registerFn('sqrt',   (...a) => Math.sqrt(Number(a[0])))

// ── Expression evaluator ──────────────────────────────────────────────────────

export function evalExpr(node: AstNode, ctx: Record<string, unknown>): unknown {
  if (node.k === 'lit') return node.value

  if (node.k === 'var') {
    if (!(node.name in ctx)) throw new RunError('R2_UNDEFINED_VAR', `variable '$${node.name}' not in context`)
    return ctx[node.name]
  }

  if (node.k === 'bin') return evalBin(node.op, evalExpr(node.left, ctx), evalExpr(node.right, ctx))

  if (node.k === 'un') {
    const v = evalExpr(node.operand, ctx)
    return node.op === '-' ? -Number(v) : !Boolean(v)
  }

  if (node.k === 'cmp') return evalCmp(node.op, evalExpr(node.left, ctx), evalExpr(node.right, ctx))

  if (node.k === 'logic') {
    if (node.op === 'NOT') return !Boolean(evalExpr(node.operands[0]!, ctx))
    if (node.op === 'AND') return node.operands.every(op => Boolean(evalExpr(op, ctx)))
    return node.operands.some(op => Boolean(evalExpr(op, ctx)))
  }

  const fn = _fns.get(node.name)
  if (!fn) throw new RunError('R2_UNKNOWN_FUNC', `unknown function '${node.name}'`)
  const args = node.args.map(a => evalExpr(a, ctx))
  try { return fn(...args) }
  catch (e) {
    if (e instanceof RunError) throw e
    throw new RunError('R2_FUNC_THREW', `${node.name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function evalBin(op: string, l: unknown, r: unknown): unknown {
  const a = Number(l); const b = Number(r)
  if (op === '+') return a + b
  if (op === '-') return a - b
  if (op === '*') return a * b
  if (op === '/') { if (b === 0) throw new RunError('R2_DIVIDE_BY_ZERO', 'division by zero'); return a / b }
  if (op === '%') { if (b === 0) throw new RunError('R2_DIVIDE_BY_ZERO', 'modulo by zero'); return a % b }
  if (op === '**') return Math.pow(a, b)
  throw new RunError('R2_OP', `unknown op ${op}`)
}

function evalCmp(op: string, l: unknown, r: unknown): boolean {
  if (typeof l === 'string' && typeof r === 'string') {
    if (op === '==') return l === r; if (op === '!=') return l !== r
    if (op === '>')  return l > r;   if (op === '<')  return l < r
    if (op === '>=') return l >= r;  return l <= r
  }
  const a = Number(l); const b = Number(r)
  if (op === '==') return a === b; if (op === '!=') return a !== b
  if (op === '>')  return a > b;   if (op === '<')  return a < b
  if (op === '>=') return a >= b;  return a <= b
}

// ── Module preparation ────────────────────────────────────────────────────────

function coerce(value: unknown, type: PrimType, name: string): unknown {
  if (value === null || value === undefined) return null
  if (type === 'num') {
    const n = Number(value)
    if (!Number.isFinite(n)) throw new InputError('R1_TYPE_MISMATCH', name, `expected num, got '${value}'`)
    return n
  }
  if (type === 'str') return String(value)
  if (type === 'bool') return Boolean(value)
  throw new InputError('R1_TYPE_MISMATCH', name, `unknown type '${type}'`)
}

function prepareValue(raw: unknown): PreparedValue {
  if (raw === null || typeof raw === 'boolean' || typeof raw === 'number')
    return { kind: 'literal', value: raw }
  if (typeof raw === 'string') {
    try {
      const ast = parseExpr(raw)
      return ast.k === 'lit' ? { kind: 'literal', value: ast.value } : { kind: 'expr', ast }
    } catch { return { kind: 'literal', value: raw } }
  }
  return { kind: 'literal', value: null }
}

function prepareOuts(outs: [string, PrimType, unknown][]): PreparedOut[] {
  return outs.map(([name, type, fb]) => ({ name, type, fallback: fb ?? null }))
}

function preparePayload(payload: Payload, outs: PreparedOut[]): PreparedPayload {
  if (Array.isArray(payload))
    return { kind: 'blocks', blocks: payload.map(b => prepareBlock(b)) }
  const outMap = new Map(outs.map(o => [o.name, o.type] as const))
  const entries: PreparedSetEntry[] = Object.entries(payload).map(([outName, raw]) => {
    const type = outMap.get(outName)
    if (!type) throw new ConfigError('S6_UNKNOWN_OUTPUT', `payload sets undeclared output '${outName}'`)
    return { output: outName, type, value: prepareValue(raw) }
  })
  return { kind: 'set', entries }
}

function prepareBlock(block: Block): PreparedBlock {
  if ('expr' in block) {
    const b = block as FormulaBlock
    return { kind: 'formula', id: b.id, outName: b.out[0], outType: b.out[1], expr: parseExpr(b.expr) }
  }
  const b = block as IfBlock
  const outs = prepareOuts(b.outs)
  return {
    kind: 'if', id: b.id, outs,
    branches: b.branches.map(([cond, payload]) => ({
      cond: parseExpr(cond),
      payload: preparePayload(payload, outs),
    })),
    else: preparePayload(b.else, outs),
  }
}

function collectBlockRefs(block: Block): Set<string> {
  const refs = new Set<string>()
  const fromExpr = (s: string) => { try { for (const r of collectVarRefs(parseExpr(s))) refs.add(r) } catch {} }
  const fromPayload = (p: Payload) => {
    if (Array.isArray(p)) { p.forEach(b => { for (const r of collectBlockRefs(b)) refs.add(r) }); return }
    Object.values(p).forEach(v => { if (typeof v === 'string') fromExpr(v) })
  }
  if ('expr' in block) fromExpr(block.expr)
  if ('branches' in block) {
    ;(block as IfBlock).branches.forEach(([cond, p]) => { fromExpr(cond); fromPayload(p) })
    fromPayload((block as IfBlock).else)
  }
  return refs
}

export function prepareModule(module: Module): PreparedModule {
  const inputs = new Set(module.inputs.map(i => i.name))
  const ownerByOutput = new Map<string, string>()
  const blockById     = new Map<string, Block>()

  for (const b of module.blocks) {
    blockById.set(b.id, b)
    const outputs = 'out' in b ? [b.out[0]] : (b as IfBlock).outs.map(o => o[0])
    for (const o of outputs) ownerByOutput.set(o, b.id)
  }

  const deps = new Map<string, Set<string>>()
  for (const b of module.blocks) {
    const dep = new Set<string>()
    for (const r of collectBlockRefs(b)) {
      if (!inputs.has(r)) { const owner = ownerByOutput.get(r); if (owner && owner !== b.id) dep.add(owner) }
    }
    deps.set(b.id, dep)
  }

  const dependents = new Map<string, Set<string>>()
  for (const id of blockById.keys()) dependents.set(id, new Set())
  for (const [id, ds] of deps) for (const d of ds) dependents.get(d)?.add(id)

  const inDegree = new Map<string, number>()
  for (const id of blockById.keys()) inDegree.set(id, deps.get(id)?.size ?? 0)

  const origIdx = new Map(module.blocks.map((b, i) => [b.id, i]))
  const queue: string[] = []
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id)
  queue.sort((a, b) => (origIdx.get(a) ?? 0) - (origIdx.get(b) ?? 0))

  const order: Block[] = []; const sorted = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    if (sorted.has(id)) continue
    sorted.add(id); order.push(blockById.get(id)!)
    const newReady: string[] = []
    for (const dep of dependents.get(id) ?? []) {
      const d = (inDegree.get(dep) ?? 0) - 1; inDegree.set(dep, d)
      if (d === 0 && !sorted.has(dep)) newReady.push(dep)
    }
    newReady.sort((a, b) => (origIdx.get(a) ?? 0) - (origIdx.get(b) ?? 0))
    queue.push(...newReady)
  }

  if (order.length !== module.blocks.length) {
    const remaining = module.blocks.filter(b => !sorted.has(b.id)).map(b => b.id)
    throw new ConfigError('S4_CYCLE', `cycle detected: ${remaining.join(', ')}`)
  }

  return { module, order: order.map(prepareBlock) }
}

// ── Module evaluation ─────────────────────────────────────────────────────────

function applyPayload(p: PreparedPayload, vars: Record<string, unknown>): void {
  if (p.kind === 'blocks') { p.blocks.forEach(b => runBlock(b, vars)); return }
  for (const e of p.entries)
    vars[e.output] = e.value.kind === 'literal' ? e.value.value : evalExpr(e.value.ast, vars)
}

function runBlock(block: PreparedBlock, vars: Record<string, unknown>): void {
  if (block.kind === 'formula') {
    vars[block.outName] = evalExpr(block.expr, vars); return
  }
  const b = block as PreparedIf
  for (const o of b.outs) vars[o.name] = o.fallback
  for (const branch of b.branches) {
    if (Boolean(evalExpr(branch.cond, vars))) { applyPayload(branch.payload, vars); return }
  }
  applyPayload(b.else, vars)
}

export function evalModule(prepared: PreparedModule, inputs: Inputs): Outputs {
  const vars: Record<string, unknown> = {}
  for (const decl of prepared.module.inputs) {
    const raw = inputs[decl.name]
    if (raw === undefined || raw === null) {
      if (decl.nullable) { vars[decl.name] = null; continue }
      throw new InputError('R1_MISSING_REQUIRED', decl.name, 'missing required input')
    }
    const val = coerce(raw, decl.type, decl.name)
    if (decl.type === 'num') {
      if (decl.min !== undefined && (val as number) < decl.min)
        throw new InputError('R1_OUT_OF_RANGE', decl.name, `${val} < min ${decl.min}`)
      if (decl.max !== undefined && (val as number) > decl.max)
        throw new InputError('R1_OUT_OF_RANGE', decl.name, `${val} > max ${decl.max}`)
    }
    vars[decl.name] = val
  }
  for (const block of prepared.order) {
    try { runBlock(block, vars) }
    catch (e) { if (e instanceof RunError) e.loc = { ...e.loc, block: block.id }; throw e }
  }
  const out: Outputs = {}
  for (const name of prepared.module.outputs) {
    if (!(name in vars)) throw new RunError('R2_OUTPUT_MISSING', `output '${name}' not produced`)
    out[name] = vars[name]
  }
  return out
}
