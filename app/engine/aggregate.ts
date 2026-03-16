import type {
  AggregateCondition,
  CompatibilityRule,
  SimulationItem,
  ValidationIssue,
} from '~/data/types'
import { render } from '~/engine/template'

// ─── computeAggregate ────────────────────────────────────────────

function computeAggregate(
  cfg: AggregateCondition['aggregate'],
  items: SimulationItem[],
): number {
  // filter items by from_types / exclude_types
  const filtered = items.filter((item) => {
    const t = item.entity.entity_type
    if (cfg.from_types[0] !== '*' && !cfg.from_types.includes(t)) return false
    if (cfg.exclude_types?.includes(t)) return false
    return true
  })

  // extract attribute value with fallback_attributes support
  // also handles nested { value, unit, si_value } structure
  const extractVal = (item: SimulationItem): number => {
    const attrs  = [cfg.attribute, ...(cfg.fallback_attributes ?? [])]
    const entity = item.entity

    for (const attr of attrs) {
      const raw = entity.attributes[attr]
      if (raw === undefined || raw === null) continue

      const num = (typeof raw === 'object' && raw !== null && 'si_value' in raw)
        ? Number((raw as { si_value: unknown }).si_value)
        : Number(raw)

      return cfg.multiply_by_quantity ? num * item.quantity : num
    }
    return 0
  }

  const values = filtered.map(extractVal)
  if (values.length === 0) return 0

  switch (cfg.function) {
    case 'sum':   return values.reduce((a, b) => a + b, 0)
    case 'count': return values.length
    case 'max':   return Math.max(...values)
    case 'min':   return Math.min(...values)
    case 'avg':   return values.reduce((a, b) => a + b, 0) / values.length
    default:      return 0
  }
}

// ─── resolveCapacity ─────────────────────────────────────────────

function resolveCapacity(
  cfg: AggregateCondition['compare_to'],
  items: SimulationItem[],
  constraints: Record<string, unknown>,
): number | null {
  let base: number | null = null

  switch (cfg.mode) {
    case 'entity_attribute': {
      const found = items.find((i) => i.entity.entity_type === cfg.entity_type)
      if (!found) return null
      const raw = found.entity.attributes[cfg.attribute!]
      base = raw !== undefined ? Number(raw) : null
      break
    }
    case 'simulation_constraint': {
      const raw = constraints[cfg.constraint_key!]
      base = raw !== undefined ? Number(raw) : null
      break
    }
    case 'fixed_value': {
      base = cfg.value ?? null
      break
    }
  }

  if (base === null) return null
  return cfg.safety_factor ? base * cfg.safety_factor : base
}

// ─── compare ─────────────────────────────────────────────────────

function compare(agg: number, op: string, cap: number): boolean {
  switch (op) {
    case '<=': return agg <= cap
    case '>=': return agg >= cap
    case '<':  return agg <  cap
    case '>':  return agg >  cap
    case '==': return agg === cap
    default:   return true
  }
}

// ─── Public API ──────────────────────────────────────────────────

export function runAggregate(
  rule: CompatibilityRule,
  items: SimulationItem[],
  constraints: Record<string, unknown>,
): ValidationIssue[] {
  const cond = rule.condition as AggregateCondition

  const aggValue = computeAggregate(cond.aggregate, items)
  const capValue = resolveCapacity(cond.compare_to, items, constraints)

  if (capValue === null) return [] // ไม่มี capacity entity → skip

  const passed = compare(aggValue, cond.operator, capValue)
  if (passed) return []

  const utilizationPct = capValue > 0
    ? Math.round((aggValue / capValue) * 100 * 10) / 10
    : 0

  // template context — ตรงกับ Issue Object ใน spec section 8
  // rule.message ใช้ :aggregate_value, :capacity_value, :utilization_pct
  const ctx: Record<string, unknown> = {
    aggregate_value:  aggValue,
    capacity_value:   capValue,
    utilization_pct:  utilizationPct,
  }

  return [{
    rule_code:  rule.code,
    check_type: 'aggregate',
    severity:   rule.severity,
    message:    render(rule.message,              ctx),
    resolution: rule.resolution ? render(rule.resolution, ctx) : undefined,
    detail: {
      aggregate_value: aggValue,
      capacity_value:  capValue,
      utilization_pct: utilizationPct,
    },
  }]
}
