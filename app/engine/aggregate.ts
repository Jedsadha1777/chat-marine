import type {
  AggregateCondition,
  CompatibilityRule,
  SimulationItem,
  ValidationIssue,
} from '~/data/types'
import { render } from '~/engine/template'

function computeAggregate(
  cfg: AggregateCondition['aggregate'],
  items: SimulationItem[],
): number {
  const filtered = items.filter((item) => {
    const t = item.entity.entity_type
    if (cfg.from_types[0] !== '*' && !cfg.from_types.includes(t)) return false
    if (cfg.exclude_types?.includes(t)) return false
    return true
  })

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
    case 'count':
      return cfg.multiply_by_quantity
        ? filtered.reduce((a, item) => a + item.quantity, 0)
        : filtered.length
    case 'max':   return Math.max(...values)
    case 'min':   return Math.min(...values)
    case 'avg':   return values.reduce((a, b) => a + b, 0) / values.length
    default:      return 0
  }
}

function resolveCapacity(
  cfg: AggregateCondition['compare_to'],
  items: SimulationItem[],
  constraints: Record<string, unknown>,
): number | null {
  let base: number | null = null

  switch (cfg.mode) {
    case 'entity_attribute': {
      // BUG-1 fix: คูณ quantity เพื่อรองรับ capacity container มากกว่า 1 ตัว (เช่น 2 UPS)
      const matching = items.filter((i) => i.entity.entity_type === cfg.entity_type)
      if (matching.length === 0) return null
      const values = matching
        .map((i) => {
          const raw = i.entity.attributes[cfg.attribute!]
          return raw !== undefined && raw !== null ? Number(raw) * i.quantity : null
        })
        .filter((v) => v !== null) as number[]
      base = values.length > 0 ? values.reduce((a, b) => a + b, 0) : null
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

  if (cfg.safety_factor !== undefined) {
    if (cfg.safety_factor <= 0 || cfg.safety_factor > 1) {
      console.warn(`[aggregate] safety_factor=${cfg.safety_factor} must be in (0, 1] — ignored`)
      return base
    }
    return base * cfg.safety_factor
  }

  return base
}

function compare(agg: number, op: string, cap: number): boolean {
  switch (op) {
    case '<=': return agg <= cap
    case '>=': return agg >= cap
    case '<':  return agg <  cap
    case '>':  return agg >  cap
    case '==': return agg === cap
    default:
      console.error(`[aggregate] Unknown operator "${op}" — treating as FAIL`)
      return false
  }
}

export function getAggregateDetail(
  rule: CompatibilityRule,
  items: SimulationItem[],
  constraints: Record<string, unknown>,
): { aggregate_value: number; capacity_value: number; utilization_pct: number } | null {
  const cond     = rule.condition as AggregateCondition
  const aggValue = computeAggregate(cond.aggregate, items)
  const capValue = resolveCapacity(cond.compare_to, items, constraints)

  if (capValue === null) return null

  const utilizationPct = capValue > 0
    ? Math.round((aggValue / capValue) * 100 * 10) / 10
    : 0

  return { aggregate_value: aggValue, capacity_value: capValue, utilization_pct: utilizationPct }
}

export function runAggregate(
  rule: CompatibilityRule,
  items: SimulationItem[],
  constraints: Record<string, unknown>,
): ValidationIssue[] {
  const cond = rule.condition as AggregateCondition

  const aggValue = computeAggregate(cond.aggregate, items)
  const capValue = resolveCapacity(cond.compare_to, items, constraints)

  if (capValue === null) return []

  const passed = compare(aggValue, cond.operator, capValue)
  if (passed) return []

  const utilizationPct = capValue > 0
    ? Math.round((aggValue / capValue) * 100 * 10) / 10
    : 0

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
