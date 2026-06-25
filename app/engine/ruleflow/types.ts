// Stripped from RuleFlow2 — num/str/bool types only, formula+if blocks only.
// Removed: dec, date, time, datetime, SwitchBlock, TableBlock, Prepared* variants for those.

export type PrimType = 'num' | 'str' | 'bool'

export interface Module {
  name: string
  ver:  string
  inputs:  InputDecl[]
  outputs: string[]
  blocks:  Block[]
}

export interface InputDecl {
  name:     string
  type:     PrimType
  nullable?: boolean
  min?:     number
  max?:     number
}

export type Block = FormulaBlock | IfBlock

export interface FormulaBlock {
  id:  string
  out: [string, PrimType]
  expr: string
}

export interface IfBlock {
  id:       string
  outs:     OutDecl[]
  branches: Branch[]
  else:     Payload
}

export type OutDecl      = [string, PrimType, number | string | boolean | null]
export type Branch       = [string, Payload]
export type Payload      = SetMap | Block[]
export type SetMap       = Record<string, number | string | boolean | null>
export type Inputs       = Record<string, unknown>
export type Outputs      = Record<string, unknown>

// ── AST (same as RuleFlow2) ───────────────────────────────────────────────────

export interface Loc { start: number; end: number }

export type AstNode =
  | LitNode | VarNode | BinNode | UnNode | CmpNode | LogicNode | CallNode

export interface LitNode   { k: 'lit';   type: PrimType; value: unknown; loc: Loc }
export interface VarNode   { k: 'var';   name: string;   loc: Loc }
export interface BinNode   { k: 'bin';   op: '+' | '-' | '*' | '/' | '%' | '**'; left: AstNode; right: AstNode; loc: Loc }
export interface UnNode    { k: 'un';    op: '-' | '!';  operand: AstNode; loc: Loc }
export interface CmpNode   { k: 'cmp';   op: '==' | '!=' | '>' | '<' | '>=' | '<='; left: AstNode; right: AstNode; loc: Loc }
export interface LogicNode { k: 'logic'; op: 'AND' | 'OR' | 'NOT'; operands: AstNode[]; loc: Loc }
export interface CallNode  { k: 'call';  name: string; args: AstNode[]; loc: Loc }

// ── Prepared forms ────────────────────────────────────────────────────────────

export type PreparedBlock = PreparedFormula | PreparedIf

export interface PreparedFormula {
  kind: 'formula'; id: string; outName: string; outType: PrimType; expr: AstNode
}
export interface PreparedIf {
  kind: 'if'; id: string; outs: PreparedOut[]; branches: PreparedBranch[]; else: PreparedPayload
}

export interface PreparedOut    { name: string; type: PrimType; fallback: unknown }
export interface PreparedBranch { cond: AstNode; payload: PreparedPayload }

export type PreparedPayload =
  | { kind: 'set';    entries: PreparedSetEntry[] }
  | { kind: 'blocks'; blocks:  PreparedBlock[] }

export interface PreparedSetEntry { output: string; type: PrimType; value: PreparedValue }
export type PreparedValue =
  | { kind: 'literal'; value: unknown }
  | { kind: 'expr';    ast: AstNode }

export interface PreparedModule { module: Module; order: PreparedBlock[] }
