/**
 * Compiles DomainConfig + candidate pool into a CPLEX-LP MILP model.
 *
 * Variables
 *   y_<id>  binary  — entity model is picked
 *   q_<id>  integer — units of that model (types with maxPerType > 1)
 *   s_<ruleId> ≥ 0  — slack for soft rules (warning severity + penalty)
 *
 * Semantics mirror the greedy engine's contract:
 *   pinned types are NOT modeled — their contributions fold into constants,
 *   and candidates pairwise-incompatible with pinned items leave the pool.
 *   excluded types are dropped entirely. Aggregate rules with no members
 *   are skipped, exactly like validateItems does.
 */

import type { Entity, AggregateCondition, CompatibilityRule } from '~/data/types'
import type { DomainConfig, SlotItem, SolverObjective } from '~/engine/engine-types'
import { runPairwise } from '~/engine/pairwise'

export interface CpsatInput {
  cfg: DomainConfig
  entities: Entity[]
  budget: number | null
  pinned?: Record<string, SlotItem[]>
  excluded?: Record<string, boolean>
  objective?: SolverObjective
  timeLimitSec?: number
  mipRelGap?: number
  /** extra LP rows appended verbatim (top-K no-good cuts) */
  extraRows?: string[]
  /** rule ids to drop (infeasibility explanation) */
  skipRuleIds?: Set<number>
  /** drop the budget row (infeasibility explanation) */
  skipBudget?: boolean
}

export interface CompiledModel {
  lp: string
  pickVarOf: Map<string, Entity>
  qtyVarOf: Map<string, Entity>
  slackPenalty: Map<string, number>
  /** contradiction detected before solving (e.g. pinned violates a hard rule) */
  infeasibleReason?: string
}

interface Term { coef: number; v: string }

function lin(terms: Term[]): string {
  const parts: string[] = []
  for (const t of terms) {
    if (t.coef === 0) continue
    const sign = t.coef < 0 ? '- ' : (parts.length === 0 ? '' : '+ ')
    parts.push(`${sign}${Math.abs(t.coef)} ${t.v}`)
  }
  return parts.length > 0 ? parts.join(' ') : '0 __zero'
}

function attrNum(e: Entity, attr: string): number {
  return Number(e.attributes[attr] ?? 0)
}

export function compileModel(input: CpsatInput): CompiledModel {
  const { cfg, budget } = input
  const pinned = input.pinned ?? {}
  const excluded = input.excluded ?? {}
  const skipRuleIds = input.skipRuleIds ?? new Set<number>()
  const objective = input.objective ?? cfg.objective ?? { mode: 'min_cost' }

  const status = cfg.publishedStatus ?? 'published'
  const pinnedTypes = new Set(Object.entries(pinned).filter(([, v]) => v.length > 0).map(([t]) => t))
  const pinnedItems: SlotItem[] = Object.values(pinned).flat()
  const pinnedEntities = pinnedItems.map((s) => s.entity)

  const activeRules = cfg.rules.filter((r) => r.is_active && !skipRuleIds.has(r.id))
  const hardPairRules = activeRules.filter((r) => r.check_type === 'pairwise' && r.severity === 'error')

  // modeled candidate pool: published, not excluded/pinned type, compatible with pinned context
  const pool = input.entities.filter((e) => {
    if (e.status !== status) return false
    if (!cfg.entityTypes.includes(e.entity_type)) return false
    if (excluded[e.entity_type] || pinnedTypes.has(e.entity_type)) return false
    return hardPairRules.every((rule) =>
      pinnedEntities.every((p) => runPairwise(rule, [e, p]).length === 0))
  })

  const byType = new Map<string, Entity[]>()
  for (const t of cfg.entityTypes) byType.set(t, pool.filter((e) => e.entity_type === t))

  const pickVarOf = new Map<string, Entity>()
  const qtyVarOf = new Map<string, Entity>()
  const slackPenalty = new Map<string, number>()
  const pickVar = (e: Entity): string => `y_${e.id}`
  const maxQtyOf = (t: string): number => cfg.maxPerType[t] ?? 1
  const countVar = (e: Entity): string => (maxQtyOf(e.entity_type) > 1 ? `q_${e.id}` : pickVar(e))

  for (const e of pool) {
    pickVarOf.set(pickVar(e), e)
    if (maxQtyOf(e.entity_type) > 1) qtyVarOf.set(`q_${e.id}`, e)
  }

  const rows: string[] = []
  let infeasibleReason: string | undefined

  // ── one-hot per modeled type ─────────────────────────────────────────────
  for (const t of cfg.entityTypes) {
    if (excluded[t] || pinnedTypes.has(t)) continue
    const members = byType.get(t) ?? []
    const required = cfg.requiredTypes.includes(t)
    if (members.length === 0) {
      if (required) infeasibleReason = `required type '${t}' has no compatible candidates`
      continue
    }
    rows.push(` req_${t}: ${lin(members.map((e) => ({ coef: 1, v: pickVar(e) })))} ${required ? '= 1' : '<= 1'}`)
  }

  // ── qty ↔ pick linking ───────────────────────────────────────────────────
  for (const [qv, e] of qtyVarOf) {
    rows.push(` lnk_${e.id}: 1 ${qv} - ${maxQtyOf(e.entity_type)} ${pickVar(e)} <= 0`)
    rows.push(` lnkmin_${e.id}: 1 ${qv} - 1 ${pickVar(e)} >= 0`)
  }

  // ── budget ───────────────────────────────────────────────────────────────
  const pinnedCost = pinnedItems.reduce((s, i) => s + attrNum(i.entity, cfg.costAttribute) * i.quantity, 0)
  if (budget !== null && Number.isFinite(budget) && !input.skipBudget) {
    const rhs = budget - pinnedCost
    if (rhs < 0) infeasibleReason ??= 'pinned items alone exceed the budget'
    else if (pool.length > 0) {
      rows.push(` budget: ${lin(pool.map((e) => ({ coef: attrNum(e, cfg.costAttribute), v: countVar(e) })))} <= ${rhs}`)
    }
  }

  // ── aggregate rules: hard rows + soft slack rows ─────────────────────────
  for (const rule of activeRules.filter((r) => r.check_type === 'aggregate')) {
    const soft = rule.severity === 'warning' && (rule.penalty ?? 0) > 0
    if (rule.severity !== 'error' && !soft) continue

    const cond = rule.condition as AggregateCondition
    const { aggregate: agg, compare_to: cap, operator } = cond
    if (operator === '<' || operator === '>') throw new Error(`UNSUPPORTED: strict operator in rule ${rule.code}`)

    const inFrom = (t: string): boolean =>
      (agg.from_types[0] === '*' || agg.from_types.includes(t)) && !agg.exclude_types?.includes(t)

    const members = pool.filter((e) => inFrom(e.entity_type))
    const pinnedMembers = pinnedItems.filter((i) => inFrom(i.entity.entity_type))
    if (members.length === 0 && pinnedMembers.length === 0) continue // no items → rule skipped (validation parity)

    // resolve RHS: constant K and/or holder terms moved to LHS
    const sf = cap.safety_factor ?? 1
    let k: number
    const holderTerms: Term[] = []
    if (cap.mode === 'fixed_value') {
      k = (cap.value ?? 0) * sf
    } else if (cap.mode === 'entity_attribute') {
      const ht = cap.entity_type ?? ''
      const pinnedHolder = (pinned[ht] ?? [])[0]?.entity
      if (pinnedHolder) k = attrNum(pinnedHolder, cap.attribute ?? '') * sf
      else if ((byType.get(ht) ?? []).length > 0) {
        k = 0
        for (const c of byType.get(ht)!) holderTerms.push({ coef: -attrNum(c, cap.attribute ?? '') * sf, v: pickVar(c) })
      } else continue // capacity holder absent → validation skips too
    } else {
      throw new Error(`UNSUPPORTED: compare_to mode '${cap.mode}' in rule ${rule.code}`)
    }

    const op = operator === '==' ? '=' : operator
    const name = `r${rule.id}`
    const slack = soft ? `s_${rule.id}` : null
    if (slack && operator === '==') throw new Error(`UNSUPPORTED: soft equality in rule ${rule.code}`)
    if (slack) slackPenalty.set(slack, rule.penalty!)

    if (agg.function === 'sum') {
      const mVar = (e: Entity): string => (agg.multiply_by_quantity ? countVar(e) : pickVar(e))
      const pinnedContrib = pinnedMembers.reduce(
        (s, i) => s + attrNum(i.entity, agg.attribute) * (agg.multiply_by_quantity ? i.quantity : 1), 0)
      const lhs: Term[] = [
        ...members.map((e) => ({ coef: attrNum(e, agg.attribute), v: mVar(e) })),
        ...holderTerms,
        ...(slack ? [{ coef: operator === '<=' ? -1 : 1, v: slack }] : []),
      ]
      if (lhs.length === 0) {
        // everything constant: check directly
        const holds = operator === '<=' ? pinnedContrib <= k : operator === '>=' ? pinnedContrib >= k : pinnedContrib === k
        if (!holds && !soft) infeasibleReason ??= `pinned items violate ${rule.code}`
        continue
      }
      rows.push(` ${name}: ${lin(lhs)} ${op} ${k - pinnedContrib}`)
    } else if (agg.function === 'min' || agg.function === 'max') {
      if (cap.mode !== 'fixed_value') throw new Error(`UNSUPPORTED: ${agg.function} with non-fixed capacity in rule ${rule.code}`)
      if (pinnedMembers.length > 0) {
        const vals = pinnedMembers.map((i) => attrNum(i.entity, agg.attribute))
        const v = agg.function === 'min' ? Math.min(...vals) : Math.max(...vals)
        const holds = operator === '<=' ? v <= k : v >= k
        if (!holds && !soft) infeasibleReason ??= `pinned items violate ${rule.code}`
        if (members.length === 0) continue
      }
      if (members.some((e) => maxQtyOf(e.entity_type) > 1)) {
        throw new Error(`UNSUPPORTED: ${agg.function} over multi-quantity type in rule ${rule.code}`)
      }
      // single-pick trick: chosen value {op} K  ⇔  Σ (attr − K)·y {op} 0
      const lhs: Term[] = [
        ...members.map((e) => ({ coef: attrNum(e, agg.attribute) - k, v: pickVar(e) })),
        ...(slack ? [{ coef: operator === '<=' ? -1 : 1, v: slack }] : []),
      ]
      rows.push(` ${name}: ${lin(lhs)} ${op} 0`)
    } else {
      throw new Error(`UNSUPPORTED: aggregate function '${agg.function}' in rule ${rule.code}`)
    }
  }

  // ── pairwise error rules among modeled candidates ────────────────────────
  const forbidden = new Set<string>()
  for (const rule of hardPairRules) {
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

  // ── objective ────────────────────────────────────────────────────────────
  const penaltyTerms: Term[] = [...slackPenalty.entries()].map(([v, w]) => ({ coef: w, v }))
  let sense: 'Minimize' | 'Maximize'
  let objTerms: Term[]
  if (objective.mode === 'min_cost') {
    sense = 'Minimize'
    objTerms = [...pool.map((e) => ({ coef: attrNum(e, cfg.costAttribute), v: countVar(e) })), ...penaltyTerms]
  } else {
    sense = 'Maximize'
    objTerms = [
      ...(byType.get(objective.type) ?? []).map((e) => ({ coef: attrNum(e, objective.attribute), v: countVar(e) })),
      ...penaltyTerms.map((t) => ({ coef: -t.coef, v: t.v })),
    ]
  }

  const bounds = [
    ...[...qtyVarOf.entries()].map(([qv, e]) => ` 0 <= ${qv} <= ${maxQtyOf(e.entity_type)}`),
    ' __zero = 0',
  ]

  const lp = [
    sense,
    ` obj: ${lin(objTerms)}`,
    'Subject To',
    ...rows,
    ...(input.extraRows ?? []),
    'Bounds',
    ...bounds,
    ...(qtyVarOf.size > 0 ? ['General', ` ${[...qtyVarOf.keys()].join(' ')}`] : []),
    ...(pickVarOf.size > 0 ? ['Binary', ` ${[...pickVarOf.keys()].join(' ')}`] : []),
    'End',
  ].join('\n')

  return { lp, pickVarOf, qtyVarOf, slackPenalty, infeasibleReason }
}
