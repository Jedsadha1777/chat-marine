import { ConfigError } from './errors'
import { isAlpha, isAlphaNum, isDigit, isWhitespace } from './util'
import type {
  AstNode, BinNode, CallNode, CmpNode, LitNode, LogicNode, UnNode, VarNode,
} from './types'

type TokenKind =
  | 'num' | 'str' | 'bool' | 'null'
  | 'var' | 'ident' | 'op' | 'logic'
  | 'lparen' | 'rparen' | 'comma' | 'eof'

interface Token { kind: TokenKind; value: string | number | boolean | null; start: number; end: number }

class TokenizeError extends Error {
  constructor(public pos: number, msg: string) {
    super(`tokenize error at ${pos}: ${msg}`)
    this.name = 'TokenizeError'
  }
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < src.length) {
    const c = src[i]
    if (isWhitespace(c!)) { i++; continue }
    if (c === '(') { tokens.push({ kind: 'lparen', value: '(', start: i, end: i + 1 }); i++; continue }
    if (c === ')') { tokens.push({ kind: 'rparen', value: ')', start: i, end: i + 1 }); i++; continue }
    if (c === ',') { tokens.push({ kind: 'comma',  value: ',', start: i, end: i + 1 }); i++; continue }

    if (c === "'" || c === '"') {
      const quote = c; const start = i; i++; let str = ''
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const next = src[i + 1]
          if (next === 'n') str += '\n'
          else if (next === 't') str += '\t'
          else if (next === 'r') str += '\r'
          else if (next === '\\') str += '\\'
          else if (next === quote) str += quote
          else str += next
          i += 2
        } else { str += src[i]; i++ }
      }
      if (i >= src.length) throw new TokenizeError(start, 'unterminated string literal')
      i++
      tokens.push({ kind: 'str', value: str, start, end: i })
      continue
    }

    if (c === '$') {
      const start = i; i++
      if (i >= src.length || !isAlpha(src[i]!)) throw new TokenizeError(start, 'expected identifier after $')
      let name = ''
      while (i < src.length && isAlphaNum(src[i]!)) { name += src[i]; i++ }
      tokens.push({ kind: 'var', value: name, start, end: i })
      continue
    }

    if (isDigit(c!)) {
      const start = i; let s = ''
      while (i < src.length && isDigit(src[i]!)) { s += src[i]; i++ }
      if (i < src.length && src[i] === '.' && i + 1 < src.length && isDigit(src[i + 1]!)) {
        s += '.'; i++
        while (i < src.length && isDigit(src[i]!)) { s += src[i]; i++ }
      }
      tokens.push({ kind: 'num', value: Number(s), start, end: i })
      continue
    }

    if (isAlpha(c!)) {
      const start = i; let name = ''
      while (i < src.length && isAlphaNum(src[i]!)) { name += src[i]; i++ }
      if (name === 'true')  { tokens.push({ kind: 'bool',  value: true,  start, end: i }); continue }
      if (name === 'false') { tokens.push({ kind: 'bool',  value: false, start, end: i }); continue }
      if (name === 'null')  { tokens.push({ kind: 'null',  value: null,  start, end: i }); continue }
      const upper = name.toUpperCase()
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
        tokens.push({ kind: 'logic', value: upper, start, end: i }); continue
      }
      tokens.push({ kind: 'ident', value: name, start, end: i })
      continue
    }

    if (c === '*' && i + 1 < src.length && src[i + 1] === '*') {
      tokens.push({ kind: 'op', value: '**', start: i, end: i + 2 }); i += 2; continue
    }
    if (c === '=' && i + 1 < src.length && src[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '==', start: i, end: i + 2 }); i += 2; continue
    }
    if (c === '!' && i + 1 < src.length && src[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '!=', start: i, end: i + 2 }); i += 2; continue
    }
    if (c === '>' && i + 1 < src.length && src[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '>=', start: i, end: i + 2 }); i += 2; continue
    }
    if (c === '<' && i + 1 < src.length && src[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '<=', start: i, end: i + 2 }); i += 2; continue
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%' || c === '>' || c === '<' || c === '!') {
      tokens.push({ kind: 'op', value: c, start: i, end: i + 1 }); i++; continue
    }

    throw new TokenizeError(i, `unexpected character '${c}'`)
  }

  tokens.push({ kind: 'eof', value: '', start: i, end: i })
  return tokens
}

const PREC_OR = 1; const PREC_AND = 2; const PREC_NOT = 3; const PREC_CMP = 4
const PREC_ADD = 5; const PREC_MUL = 6; const PREC_UNARY = 7; const PREC_POW = 8

class ParseState {
  i = 0
  constructor(public tokens: Token[]) {}
  peek(): Token { return this.tokens[this.i]! }
  next(): Token { return this.tokens[this.i++]! }
  expect(kind: TokenKind): Token {
    const t = this.next()
    if (t.kind !== kind)
      throw new ConfigError('S5_EXPR_PARSE', `expected ${kind}, got ${String(t.value)} at col ${t.start}`)
    return t
  }
}

export function parseExpr(src: string): AstNode {
  const tokens = tokenize(src)
  const st = new ParseState(tokens)
  const node = parseExpression(st, 0)
  if (st.peek().kind !== 'eof') {
    const t = st.peek()
    throw new ConfigError('S5_EXPR_PARSE', `unexpected token '${String(t.value)}' at col ${t.start}`)
  }
  return node
}

function parseExpression(st: ParseState, minPrec: number): AstNode {
  let left = parsePrefix(st)
  while (true) {
    const t = st.peek()
    const lbp = leftBindingPower(t)
    if (lbp <= minPrec) break
    left = parseInfix(st, left, t, lbp)
  }
  return left
}

function parsePrefix(st: ParseState): AstNode {
  const t = st.next()
  if (t.kind === 'num')  return { k: 'lit', type: 'num',  value: t.value, loc: { start: t.start, end: t.end } } as LitNode
  if (t.kind === 'str')  return { k: 'lit', type: 'str',  value: t.value, loc: { start: t.start, end: t.end } } as LitNode
  if (t.kind === 'bool') return { k: 'lit', type: 'bool', value: t.value, loc: { start: t.start, end: t.end } } as LitNode
  if (t.kind === 'null') return { k: 'lit', type: 'num',  value: null,    loc: { start: t.start, end: t.end } } as LitNode
  if (t.kind === 'var')  return { k: 'var', name: String(t.value), loc: { start: t.start, end: t.end } } as VarNode
  if (t.kind === 'lparen') {
    const inner = parseExpression(st, 0); st.expect('rparen'); return inner
  }
  if (t.kind === 'op' && (t.value === '-' || t.value === '!')) {
    const operand = parseExpression(st, PREC_UNARY)
    return { k: 'un', op: t.value as '-' | '!', operand, loc: { start: t.start, end: operand.loc.end } } as UnNode
  }
  if (t.kind === 'logic' && t.value === 'NOT') {
    const operand = parseExpression(st, PREC_NOT)
    return { k: 'logic', op: 'NOT', operands: [operand], loc: { start: t.start, end: operand.loc.end } } as LogicNode
  }
  if (t.kind === 'ident') {
    if (st.peek().kind !== 'lparen')
      throw new ConfigError('S5_EXPR_PARSE', `bare identifier '${String(t.value)}' not allowed (use $var) at col ${t.start}`)
    st.next()
    const args: AstNode[] = []
    if (st.peek().kind !== 'rparen') {
      args.push(parseExpression(st, 0))
      while (st.peek().kind === 'comma') { st.next(); args.push(parseExpression(st, 0)) }
    }
    const rp = st.expect('rparen')
    return { k: 'call', name: String(t.value), args, loc: { start: t.start, end: rp.end } } as CallNode
  }
  throw new ConfigError('S5_EXPR_PARSE', `unexpected token '${String(t.value)}' at col ${t.start}`)
}

function leftBindingPower(t: Token): number {
  if (t.kind === 'op') {
    if (t.value === '**') return PREC_POW
    if (t.value === '*' || t.value === '/' || t.value === '%') return PREC_MUL
    if (t.value === '+' || t.value === '-') return PREC_ADD
    if (['>', '<', '>=', '<=', '==', '!='].includes(t.value as string)) return PREC_CMP
  }
  if (t.kind === 'logic') {
    if (t.value === 'AND') return PREC_AND
    if (t.value === 'OR')  return PREC_OR
  }
  return 0
}

function parseInfix(st: ParseState, left: AstNode, opTok: Token, lbp: number): AstNode {
  st.next()
  const isRightAssoc = opTok.kind === 'op' && opTok.value === '**'
  const right = parseExpression(st, isRightAssoc ? lbp - 1 : lbp)
  const loc = { start: left.loc.start, end: right.loc.end }
  if (opTok.kind === 'op') {
    const op = String(opTok.value)
    if (['+', '-', '*', '/', '%', '**'].includes(op))
      return { k: 'bin', op: op as BinNode['op'], left, right, loc } as BinNode
    return { k: 'cmp', op: op as CmpNode['op'], left, right, loc } as CmpNode
  }
  const op = String(opTok.value) as 'AND' | 'OR'
  if (left.k === 'logic' && left.op === op)
    return { k: 'logic', op, operands: [...left.operands, right], loc }
  return { k: 'logic', op, operands: [left, right], loc }
}

export function walkAst(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node)
  if (node.k === 'bin' || node.k === 'cmp') { walkAst(node.left, visit); walkAst(node.right, visit) }
  else if (node.k === 'un') walkAst(node.operand, visit)
  else if (node.k === 'logic') for (const c of node.operands) walkAst(c, visit)
  else if (node.k === 'call') for (const a of node.args) walkAst(a, visit)
}

export function collectVarRefs(node: AstNode): Set<string> {
  const refs = new Set<string>()
  walkAst(node, n => { if (n.k === 'var') refs.add(n.name) })
  return refs
}
