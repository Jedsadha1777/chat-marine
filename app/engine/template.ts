// ═════════════════════════════════════════════════════════════════
//  TOKEN
// ═════════════════════════════════════════════════════════════════

const enum TT {
  TEXT, VAR, PIPE, FILTER_NAME,
  ARG_LITERAL, ARG_VAR, ARGS_START, ARGS_END, COMMA, EOF,
}

interface Token { type: TT; value: string; position: number }

// ═════════════════════════════════════════════════════════════════
//  AST NODES
// ═════════════════════════════════════════════════════════════════

export interface FilterArg  { value: string; isVar: boolean }
export interface FilterNode { name: string;  args: FilterArg[] }
export interface TextNode   { kind: 'text';  value: string }
export interface VarNode    { kind: 'var';   path: string; filters: FilterNode[] }
export interface RootNode   { kind: 'root';  children: (TextNode | VarNode)[] }

// ═════════════════════════════════════════════════════════════════
//  LEXER
// ═════════════════════════════════════════════════════════════════

const WORD_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.'
const VAR_START  = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'

class Lexer {
  private pos = 0
  constructor(private input: string, private length = input.length) {}

  tokenize(): Token[] {
    const tokens: Token[] = []
    let text = ''

    while (this.pos < this.length) {
      const ch = this.ch(this.pos)

      // :: → literal colon
      if (ch === ':' && this.ch(this.pos + 1) === ':') {
        text += ':'
        this.pos += 2
        continue
      }

      // :word → variable expression
      if (ch === ':' && this.isVarStart(this.ch(this.pos + 1))) {
        if (text !== '') {
          tokens.push({ type: TT.TEXT, value: text, position: this.pos - text.length })
          text = ''
        }
        this.pos++ // skip :
        this.readExpr(tokens)
        continue
      }

      text += ch
      this.pos++
    }

    if (text !== '') tokens.push({ type: TT.TEXT, value: text, position: this.pos - text.length })
    tokens.push({ type: TT.EOF, value: '', position: this.pos })
    return tokens
  }

  private readExpr(tokens: Token[]): void {
    const varStart = this.pos
    const varName  = this.readWord()
    if (varName === '') return

    tokens.push({ type: TT.VAR, value: varName, position: varStart })

    // filter chain with backtrack
    while (this.pos < this.length) {
      const saved = this.pos
      this.skipSpaces()

      if (this.ch(this.pos) !== '|') { this.pos = saved; break }

      const pipePos = this.pos
      this.pos++ // skip |
      this.skipSpaces()

      const fStart = this.pos
      const fName  = this.readWord()
      if (fName === '') { this.pos = saved; break }

      tokens.push({ type: TT.PIPE,        value: '|',    position: pipePos })
      tokens.push({ type: TT.FILTER_NAME, value: fName,  position: fStart  })

      if (this.ch(this.pos) === '(') this.readArgs(tokens)
    }
  }

  private readArgs(tokens: Token[]): void {
    tokens.push({ type: TT.ARGS_START, value: '(', position: this.pos })
    this.pos++ // skip (

    while (this.pos < this.length) {
      this.skipSpaces()
      const ch = this.ch(this.pos)

      if (ch === ')') {
        this.pos++
        tokens.push({ type: TT.ARGS_END, value: ')', position: this.pos })
        return
      }

      if (ch === ',') {
        this.pos++
        tokens.push({ type: TT.COMMA, value: ',', position: this.pos })
        continue
      }

      if (ch === ':' && this.isVarStart(this.ch(this.pos + 1))) {
        this.pos++ // skip :
        const start = this.pos
        const word  = this.readWord()
        tokens.push({ type: TT.ARG_VAR, value: word, position: start })
        continue
      }

      if (ch === '"') {
        const start = this.pos
        const text  = this.readQuoted()
        tokens.push({ type: TT.ARG_LITERAL, value: text, position: start })
        continue
      }

      const start = this.pos
      const text  = this.readUntilArgEnd()
      if (text !== '') tokens.push({ type: TT.ARG_LITERAL, value: text, position: start })
    }
  }

  private readQuoted(): string {
    this.pos++ // skip opening "
    let buf = ''
    while (this.pos < this.length) {
      const ch = this.input[this.pos]
      if (ch === '\\' && this.pos + 1 < this.length) {
        const next = this.input[this.pos + 1]
        if (next === '"' || next === '\\' || next === ',' || next === ')') {
          buf += next; this.pos += 2; continue
        }
      }
      if (ch === '"') { this.pos++; return buf }
      buf += ch; this.pos++
    }
    return buf // unclosed quote
  }

  private readUntilArgEnd(): string {
    let buf = ''
    while (this.pos < this.length) {
      const ch = this.ch(this.pos)
      if (ch === ',' || ch === ')') break
      buf += ch; this.pos++
    }
    return buf.trim()
  }

  private readWord(): string {
    let buf = ''
    while (this.pos < this.length && WORD_CHARS.includes(this.input[this.pos])) {
      buf += this.input[this.pos]; this.pos++
    }
    return buf
  }

  private skipSpaces(): void {
    while (this.pos < this.length && this.input[this.pos] === ' ') this.pos++
  }

  private ch(i: number): string { return i < this.length ? this.input[i] : '' }
  private isVarStart(ch: string): boolean { return ch !== '' && VAR_START.includes(ch) }
}

// ═════════════════════════════════════════════════════════════════
//  PARSER  (Tokens → AST)
// ═════════════════════════════════════════════════════════════════

class Parser {
  private tokens: Token[] = []
  private pos = 0

  parse(tokens: Token[]): RootNode {
    this.tokens = tokens
    this.pos    = 0
    const children: (TextNode | VarNode)[] = []

    while (!this.is(TT.EOF)) {
      const cur = this.cur()
      if      (cur.type === TT.VAR)  children.push(this.parseVar())
      else if (cur.type === TT.TEXT) children.push(this.parseText())
      else { children.push({ kind: 'text', value: cur.value }); this.adv() }
    }

    return { kind: 'root', children }
  }

  private parseText(): TextNode {
    const v = this.cur().value; this.adv()
    return { kind: 'text', value: v }
  }

  private parseVar(): VarNode {
    const path = this.cur().value; this.adv()
    const filters: FilterNode[] = []

    while (this.is(TT.PIPE)) {
      this.adv() // skip PIPE
      filters.push(this.parseFilter())
    }

    return { kind: 'var', path, filters }
  }

  private parseFilter(): FilterNode {
    let name = ''
    if (this.is(TT.FILTER_NAME)) { name = this.cur().value; this.adv() }

    const args: FilterArg[] = []

    if (this.is(TT.ARGS_START)) {
      this.adv() // skip (
      while (!this.is(TT.ARGS_END) && !this.is(TT.EOF)) {
        if (this.is(TT.COMMA)) { this.adv(); continue }
        args.push({ value: this.cur().value, isVar: this.is(TT.ARG_VAR) })
        this.adv()
      }
      if (this.is(TT.ARGS_END)) this.adv() // skip )
    }

    return { name, args }
  }

  private cur(): Token  { return this.tokens[this.pos] }
  private adv(): void   { this.pos++ }
  private is(t: TT): boolean {
    return this.pos < this.tokens.length && this.tokens[this.pos].type === t
  }
}

// ═════════════════════════════════════════════════════════════════
//  FILTER REGISTRY
// ═════════════════════════════════════════════════════════════════

type FilterFn = (value: unknown, ...args: string[]) => unknown

class FilterRegistry {
  private filters: Record<string, FilterFn> = {}
  private strict = false

  constructor() { this.registerDefaults() }

  setStrict(s: boolean): void { this.strict = s }
  isStrict(): boolean { return this.strict }
  has(name: string): boolean { return name in this.filters }

  register(name: string, fn: FilterFn): void { this.filters[name] = fn }

  apply(name: string, value: unknown, args: string[]): unknown {
    if (!this.has(name)) {
      if (this.strict) throw new Error(`Unknown template filter: '${name}'.`)
      return value // passthrough
    }
    return this.filters[name](value, ...args)
  }

  private registerDefaults(): void {
    const f = this.filters

    // Formatting
    f['round']  = (v, d = '2')  => Number(v).toFixed(Number(d))
    f['number'] = (v, d = '0')  => Number(v).toLocaleString('en-US', {
      minimumFractionDigits: Number(d), maximumFractionDigits: Number(d),
    })
    f['prefix'] = (v, p = '')    => `${p}${v}`
    f['suffix'] = (v, s = '')    => `${v}${s}`
    f['wrap']   = (v, l = '', r = '') => `${l}${v}${r !== '' ? r : l}`
    f['unit']   = (v, u = '')    => `${v} ${u}`

    // String
    f['upper']     = (v)              => String(v).toUpperCase()
    f['lower']     = (v)              => String(v).toLowerCase()
    f['trim']      = (v)              => String(v).trim()
    f['truncate']  = (v, len = '50', ell = '...') => {
      const s = String(v); const l = Number(len)
      return [...s].length > l ? [...s].slice(0, l).join('') + ell : s
    }
    f['replace']   = (v, s = '', r = '') => String(v).split(s).join(r)
    f['pad_left']  = (v, n = '0', c = ' ') => String(v).padStart(Number(n), c)
    f['pad_right'] = (v, n = '0', c = ' ') => String(v).padEnd(Number(n), c)

    // Default
    f['default'] = (v, fb = '') => (v === null || v === undefined || v === '') ? fb : v

    // Math
    f['add']      = (v, n)        => Number(v) + Number(n)
    f['sub']      = (v, n)        => Number(v) - Number(n)
    f['multiply'] = (v, n)        => Number(v) * Number(n)
    f['divide']   = (v, d)        => Number(d) !== 0 ? Number(v) / Number(d) : 0
    f['abs']      = (v)           => Math.abs(Number(v))
    f['ceil']     = (v)           => Math.ceil(Number(v))
    f['floor']    = (v)           => Math.floor(Number(v))
    f['min']      = (v, o)        => Math.min(Number(v), Number(o))
    f['max']      = (v, o)        => Math.max(Number(v), Number(o))
    f['clamp']    = (v, lo, hi)   => Math.max(Number(lo), Math.min(Number(hi), Number(v)))
    f['percent']  = (v, total)    => {
      const t = Number(total)
      return t !== 0 ? `${((Number(v) / t) * 100).toFixed(1)}%` : '0%'
    }

    // Comparison (return bool → chain with then)
    f['eq']      = (v, c)        => String(v) === c
    f['neq']     = (v, c)        => String(v) !== c
    f['gt']      = (v, c)        => Number(v) > Number(c)
    f['gte']     = (v, c)        => Number(v) >= Number(c)
    f['lt']      = (v, c)        => Number(v) < Number(c)
    f['lte']     = (v, c)        => Number(v) <= Number(c)
    f['not']     = (v)           => !v
    f['between'] = (v, lo, hi)   => Number(v) >= Number(lo) && Number(v) <= Number(hi)
    f['in']      = (v, ...opts)  => opts.includes(String(v))

    // Conditional
    f['then'] = (v, ifTrue = '', ifFalse = '') => v ? ifTrue : ifFalse

    // Type casting
    f['int']    = (v) => Math.trunc(Number(v))
    f['float']  = (v) => Number(v)
    f['string'] = (v) => String(v)
    f['bool']   = (v) => Boolean(v)

    // JSON
    f['json'] = (v) => { try { return JSON.stringify(v) } catch { return '' } }

    // Date
    f['date'] = (v, fmt = 'Y-m-d') => {
      if (v === null || v === undefined || v === '') return String(v)
      const d = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v))
      if (isNaN(d.getTime())) return String(v)
      const pad = (n: number) => String(n).padStart(2, '0')
      return (fmt as string)
        .replace('Y', String(d.getFullYear()))
        .replace('y', String(d.getFullYear()).slice(-2))
        .replace('m', pad(d.getMonth() + 1))
        .replace('n', String(d.getMonth() + 1))
        .replace('d', pad(d.getDate()))
        .replace('j', String(d.getDate()))
        .replace('H', pad(d.getHours()))
        .replace('i', pad(d.getMinutes()))
        .replace('s', pad(d.getSeconds()))
    }

    f['date_diff'] = (v, unit = 'days') => {
      const d   = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v))
      const ms  = Date.now() - d.getTime()
      const day = Math.floor(ms / 86400000)
      switch (unit) {
        case 'years':  case 'y': return String(Math.floor(day / 365))
        case 'months': case 'm': return String(Math.floor(day / 30))
        case 'days':   case 'd': return String(day)
        case 'hours':  case 'h': return String(Math.floor(ms / 3600000))
        case 'minutes':case 'i': return String(Math.floor(ms / 60000))
        default: return String(day)
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════
//  EVALUATOR  (AST Walker)
// ═════════════════════════════════════════════════════════════════

class Evaluator {
  private flat: Record<string, unknown> = {}

  constructor(private registry: FilterRegistry) {}

  evaluate(ast: RootNode, data: Record<string, unknown>): string {
    this.flat = this.flatten(data)
    let out = ''
    for (const node of ast.children) {
      out += node.kind === 'text'
        ? (node as TextNode).value
        : this.evalVar(node as VarNode)
    }
    return out
  }

  private evalVar(node: VarNode): string {
    let value: unknown = this.resolve(node.path)

    for (const filter of node.filters) {
      const args = filter.args.map((a) =>
        a.isVar
          ? (() => { const r = this.resolve(a.value); return r === null || r === undefined ? '' : String(r) })()
          : a.value
      )
      value = this.registry.apply(filter.name, value, args)
    }

    if (value === null || value === undefined) return ''
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (typeof value === 'number')  return this.formatFloat(value)
    return String(value)
  }

  /**
   * formatFloat — mirrors PHP formatFloat exactly:
   * 500.0      → "500"
   * 0.1 + 0.2  → "0.3"  (not 0.30000000000000004)
   * 1e-7       → "1e-7"
   * NaN        → "NaN"
   * Infinity   → "Infinity"
   */
  private formatFloat(value: number): string {
    if (isNaN(value))     return 'NaN'
    if (!isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity'

    // integer stored as float
    if (value % 1 === 0 && Math.abs(value) < 1e15) return String(Math.trunc(value))

    // extreme values → scientific notation
    if (Math.abs(value) >= 1e15 || (Math.abs(value) > 0 && Math.abs(value) < 1e-6)) {
      return value.toExponential()
    }

    // normal range → up to 10 significant digits, strip trailing zeros
    let str = parseFloat(value.toPrecision(10)).toString()
    return str
  }

  private resolve(path: string): unknown {
    return this.flat[path] ?? null
  }

  /**
   * Flatten nested object to dot notation
   * { a: { b: 1 } } → { "a": {b:1}, "a.b": 1 }
   */
  private flatten(data: Record<string, unknown>, prefix = ''): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
      const fullKey = prefix === '' ? key : `${prefix}.${key}`
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[fullKey] = value
        Object.assign(result, this.flatten(value as Record<string, unknown>, fullKey))
      } else {
        result[fullKey] = value
      }
    }
    return result
  }
}

// ═════════════════════════════════════════════════════════════════
//  TEMPLATE ENGINE  (Facade — singleton, cached AST)
// ═════════════════════════════════════════════════════════════════

const _parser    = new Parser()
const _registry  = new FilterRegistry()
const _evaluator = new Evaluator(_registry)
const _cache     = new Map<string, RootNode>()

function _compile(template: string): RootNode {
  if (!_cache.has(template)) {
    _cache.set(template, _parser.parse(new Lexer(template).tokenize()))
  }
  return _cache.get(template)!
}

export function render(template: string, data: Record<string, unknown>): string {
  return _evaluator.evaluate(_compile(template), data)
}

export function registerFilter(name: string, fn: FilterFn): void {
  _registry.register(name, fn)
}

export function setStrict(strict: boolean): void {
  _registry.setStrict(strict)
}

export function clearCache(): void {
  _cache.clear()
}
