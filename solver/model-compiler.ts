/**
 * Compiles a DomainConfig + entity catalog into a CPLEX-LP MILP model.
 *
 * Encoding:
 *   y_<id>  binary  — entity model is picked
 *   q_<id>  integer — units of that model (only for types with maxPerType > 1)
 *   one-hot per type (= 1 for requiredTypes, <= 1 otherwise)
 *   aggregate error rules → linear rows (sum; min/max on single-pick types)
 *   pairwise error rules  → y_a + y_b <= 1 (evaluated with the REAL runPairwise)
 *
 * Lab-only: imported by test/, never by app/ or server/.
 */

import type { Entity, AggregateCondition, CompatibilityRule } from '~/data/types'
import type { DomainConfig } from '~/engine/suggest'
import { runPairwise } from '~/engine/pairwise'

export type Objective =
  | { mode: 'min_cost' }
  | { mode: 'max_attribute'; type: string; attribute: string }

export interface CompileInput {
  cfg: DomainConfig
  entities: Entity[]
  budget: number | null
  objective: Objective
}

export interface CompiledModel {
  lp: string
  pickVarOf: Map<string, Entity>
  qtyVarOf: Map<string, Entity>
}

interface Term { coef: number; v: string }

function lin(terms: Term[]): string {
  const parts: string[] = []
  for (const t of terms) {
    if (t.coef === 0) continue
    const sign = t.coef < 0 ? '- ' : (parts.length === 0 ? '' : '+ ')
    parts.push(`${sign}${Math.abs(t.coef)} ${t.v}`)
  }
  return parts.join(' ')
}

function attrNum(e: Entity, attr: string): number {
  return Number(e.attributes[attr] ?? 0)
}

export function compileModel({ cfg, entities, budget, objective }: CompileInput): CompiledModel {
  const status = cfg.publishedStatus ?? 'published'
  const pool = entities.filter((e) => e.status === status)

  const byType = new Map<string, Entity[]>()
  for (const t of cfg.entityTypes) byType.set(t, pool.filter((e) => e.entity_type === t))

  const pickVarOf = new Map<string, Entity>()
  const qtyVarOf = new Map<string, Entity>()
  const pickVar = (e: Entity): string => `y_${e.id}`
  const maxQtyOf = (t: string): number => cfg.maxPerType[t] ?? 1
  // the variable that counts units of a model (q for multi-qty types, y otherwise)
  const countVar = (e: Entity): string =>
    maxQtyOf(e.entity_type) > 1 ? `q_${e.id}` : pickVar(e)

  for (const e of pool) {
    pickVarOf.set(pickVar(e), e)
    if (maxQtyOf(e.entity_type) > 1) qtyVarOf.set(`q_${e.id}`, e)
  }

  const rows: string[] = []

  // one-hot per type
  for (const t of cfg.entityTypes) {
    const members = byType.get(t) ?? []
    if (members.length === 0) continue
    const op = cfg.requiredTypes.includes(t) ? '= 1' : '<= 1'
    rows.push(` req_${t}: ${lin(members.map((e) => ({ coef: 1, v: pickVar(e) })))} ${op}`)
  }

  // qty ↔ pick linking
  for (const [qv, e] of qtyVarOf) {
    const max = maxQtyOf(e.entity_type)
    rows.push(` lnk_${e.id}: 1 ${qv} - ${max} ${pickVar(e)} <= 0`)
    rows.push(` lnkmin_${e.id}: 1 ${qv} - 1 ${pickVar(e)} >= 0`)
  }

  // budget
  if (budget !== null) {
    const terms = pool.map((e) => ({ coef: attrNum(e, cfg.costAttribute), v: countVar(e) }))
    rows.push(` budget: ${lin(terms)} <= ${budget}`)
  }

  // aggregate error rules → linear rows
  const activeRules = cfg.rules.filter((r) => r.is_active && r.severity === 'error')
  for (const rule of activeRules.filter((r) => r.check_type === 'aggregate')) {
    const cond = rule.condition as AggregateCondition
    const { aggregate: agg, compare_to: cap, operator } = cond
    if (operator === '<' || operator === '>') {
      throw new Error(`UNSUPPORTED: strict operator '${operator}' in rule ${rule.code}`)
    }
    const op = operator === '==' ? '=' : operator

    const members = pool.filter((e) => {
      const t = e.entity_type
      if (agg.from_types[0] !== '*' && !agg.from_types.includes(t)) return false
      if (agg.exclude_types?.includes(t)) return false
      return true
    })
    const memberVar = (e: Entity): string => (agg.multiply_by_quantity ? countVar(e) : pickVar(e))

    if (agg.function === 'sum') {
      const lhs: Term[] = members.map((e) => ({ coef: attrNum(e, agg.attribute), v: memberVar(e) }))
      if (cap.mode === 'fixed_value') {
        const rhs = (cap.value ?? 0) * (cap.safety_factor ?? 1)
        rows.push(` r${rule.id}_${rule.code.toLowerCase()}: ${lin(lhs)} ${op} ${rhs}`)
      } else if (cap.mode === 'entity_attribute') {
        const holders = byType.get(cap.entity_type ?? '') ?? []
        const sf = cap.safety_factor ?? 1
        const rhsTerms: Term[] = holders.map((c) => ({ coef: -attrNum(c, cap.attribute ?? '') * sf, v: pickVar(c) }))
        rows.push(` r${rule.id}_${rule.code.toLowerCase()}: ${lin([...lhs, ...rhsTerms])} ${op} 0`)
      } else {
        throw new Error(`UNSUPPORTED: compare_to mode '${cap.mode}' in rule ${rule.code}`)
      }
    } else if (agg.function === 'min' || agg.function === 'max') {
      // only sound when every member belongs to a single-pick (maxQty=1) one-hot type:
      // chosen value {op} K  ⇔  Σ (attr_e − K)·y_e {op} 0
      const multiQty = members.find((e) => maxQtyOf(e.entity_type) > 1)
      if (multiQty) throw new Error(`UNSUPPORTED: ${agg.function} over multi-quantity type in rule ${rule.code}`)
      if (cap.mode !== 'fixed_value') throw new Error(`UNSUPPORTED: ${agg.function} with non-fixed capacity in rule ${rule.code}`)
      const k = (cap.value ?? 0) * (cap.safety_factor ?? 1)
      const lhs: Term[] = members.map((e) => ({ coef: attrNum(e, agg.attribute) - k, v: pickVar(e) }))
      rows.push(` r${rule.id}_${rule.code.toLowerCase()}: ${lin(lhs)} ${op} 0`)
    } else {
      throw new Error(`UNSUPPORTED: aggregate function '${agg.function}' in rule ${rule.code}`)
    }
  }

  // pairwise error rules → forbidden pairs
  const forbidden = new Set<string>()
  const pairRules: CompatibilityRule[] = activeRules.filter((r) => r.check_type === 'pairwise')
  for (const rule of pairRules) {
    for (const a of pool) {
      for (const b of pool) {
        if (a.id >= b.id || a.entity_type === b.entity_type) continue
        if (runPairwise(rule, [a, b]).length > 0) forbidden.add(`${a.id}_${b.id}`)
      }
    }
  }
  for (const key of forbidden) {
    const [aId, bId] = key.split('_')
    rows.push(` pr_${key}: 1 y_${aId} + 1 y_${bId} <= 1`)
  }

  // objective
  let sense: string
  let objTerms: Term[]
  if (objective.mode === 'min_cost') {
    sense = 'Minimize'
    objTerms = pool.map((e) => ({ coef: attrNum(e, cfg.costAttribute), v: countVar(e) }))
  } else {
    sense = 'Maximize'
    objTerms = (byType.get(objective.type) ?? []).map((e) => ({ coef: attrNum(e, objective.attribute), v: countVar(e) }))
  }

  const bounds = [...qtyVarOf.entries()].map(([qv, e]) => ` 0 <= ${qv} <= ${maxQtyOf(e.entity_type)}`)

  const lp = [
    sense,
    ` obj: ${lin(objTerms)}`,
    'Subject To',
    ...rows,
    'Bounds',
    ...bounds,
    'General',
    ` ${[...qtyVarOf.keys()].join(' ')}`,
    'Binary',
    ` ${[...pickVarOf.keys()].join(' ')}`,
    'End',
  ].join('\n')

  return { lp, pickVarOf, qtyVarOf }
}
