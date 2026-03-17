import type { CompatibilityRule, Entity, ValidationIssue } from '~/data/types'
import { render } from '~/engine/template'

function evalLogic(logic: unknown, data: Record<string, unknown>): boolean {
  if (typeof logic !== 'object' || logic === null) return Boolean(logic)

  const entries = Object.entries(logic as Record<string, unknown>)
  if (entries.length === 0) return false

  const [op, operands] = entries[0]
  const args = Array.isArray(operands) ? operands : [operands]

  const resolve = (val: unknown): unknown => {
    if (typeof val === 'object' && val !== null && 'var' in val) {
      const path = (val as { var: string }).var
      return path.split('.').reduce((acc: unknown, key: string) => {
        if (acc === null || acc === undefined) return null
        return (acc as Record<string, unknown>)[key]
      }, data)
    }
    return val
  }

  switch (op) {
    case '==': {
      const a = resolve(args[0])
      const b = resolve(args[1])
      if (Array.isArray(a)) return a.includes(b)
      if (Array.isArray(b)) return b.includes(a)
      return a === b
    }
    case '!=': {
      const a = resolve(args[0])
      const b = resolve(args[1])
      if (Array.isArray(a)) return !a.includes(b)
      if (Array.isArray(b)) return !b.includes(a)
      return a !== b
    }
    case '<=':  return Number(resolve(args[0])) <= Number(resolve(args[1]))
    case '>=':  return Number(resolve(args[0])) >= Number(resolve(args[1]))
    case '<':   return Number(resolve(args[0])) <  Number(resolve(args[1]))
    case '>':   return Number(resolve(args[0])) >  Number(resolve(args[1]))
    case 'in': {
      const needle   = resolve(args[0])
      const haystack = resolve(args[1])
      return Array.isArray(haystack) ? haystack.includes(needle) : haystack === needle
    }
    case 'and': return (args as unknown[]).every((a) => evalLogic(a, data))
    case 'or':  return (args as unknown[]).some((a)  => evalLogic(a, data))
    case 'not': return !evalLogic(args[0], data)
    default:
      console.error(`[pairwise] Unknown operator "${op}" — treating as FAIL`)
      return false
  }
}

interface ScopedPairs {
  sources: Entity[]
  targets: Entity[]
}

function getScopedPairs(rule: CompatibilityRule, entities: Entity[]): ScopedPairs {
  const scope = rule.scope

  if (!scope) {
    return { sources: entities, targets: entities }
  }

  switch (scope.match_by) {
    case 'shared_attribute': {
      const key = scope.attribute_key!
      const sources = entities.filter((e) =>
        key in e.attributes &&
        (!scope.source_types || scope.source_types.includes(e.entity_type)),
      )
      const targets = entities.filter((e) =>
        key in e.attributes &&
        (!scope.target_types || scope.target_types.includes(e.entity_type)),
      )
      return { sources, targets }
    }
    case 'attribute_pair': {
      const srcAttr = scope.source_attribute!
      const tgtAttr = scope.target_attribute!
      return {
        sources: entities.filter((e) =>
          srcAttr in e.attributes &&
          (!scope.source_types || scope.source_types.includes(e.entity_type)),
        ),
        targets: entities.filter((e) =>
          tgtAttr in e.attributes &&
          (!scope.target_types || scope.target_types.includes(e.entity_type)),
        ),
      }
    }
    case 'attribute_range': {
      return {
        sources: scope.source_types
          ? entities.filter((e) => scope.source_types!.includes(e.entity_type))
          : entities,
        targets: scope.target_types
          ? entities.filter((e) => scope.target_types!.includes(e.entity_type))
          : entities,
      }
    }
    default:
      return { sources: [], targets: [] }
  }
}

export function runPairwise(
  rule: CompatibilityRule,
  entities: Entity[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { sources, targets } = getScopedPairs(rule, entities)
  const seenPairs = new Set<string>()

  for (const source of sources) {
    for (const target of targets) {
      if (source.id === target.id) continue

      const passed = evalLogic(rule.condition, { source, target })

      if (!passed) {
        const lo = Math.min(source.id, target.id)
        const hi = Math.max(source.id, target.id)
        const pairKey = `${rule.code}:${lo}:${hi}`
        if (seenPairs.has(pairKey)) continue
        seenPairs.add(pairKey)

        issues.push({
          rule_code:  rule.code,
          check_type: 'pairwise',
          severity:   rule.severity,
          message:    render(rule.message,   { source, target }),
          resolution: rule.resolution
            ? render(rule.resolution, { source, target })
            : undefined,
          detail: {
            source_entity: source.name,
            target_entity: target.name,
          },
        })
      }
    }
  }

  return issues
}
