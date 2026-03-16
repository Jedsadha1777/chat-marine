import type { CompatibilityRule, Entity, ValidationIssue } from '~/data/types'
import { render } from '~/engine/template'

// ─── JSON Logic evaluator ─────────────────────────────────────────
// Supports: ==, !=, <=, >=, <, >, in, and, or, not, var

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
    case '==':  return resolve(args[0]) == resolve(args[1])
    case '!=':  return resolve(args[0]) != resolve(args[1])
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
    default:    return true
  }
}

// ─── Scope-based entity pre-filter ───────────────────────────────
// Pre-filter ก่อนเข้า loop เพื่อลด pairs จาก O(n²) เต็ม
// เหลือเฉพาะคู่ที่ scope กำหนด

interface ScopedPairs {
  sources: Entity[]
  targets: Entity[]
}

function getScopedPairs(rule: CompatibilityRule, entities: Entity[]): ScopedPairs {
  const scope = rule.scope

  if (!scope) {
    // ไม่มี scope → ทุก entity เป็นได้ทั้ง source และ target
    return { sources: entities, targets: entities }
  }

  switch (scope.match_by) {
    case 'shared_attribute': {
      // ทั้งสองต้องมี attribute เดียวกัน → filter เฉพาะตัวที่มี attribute นั้น
      const key = scope.attribute_key!
      const eligible = entities.filter((e) => key in e.attributes)
      return { sources: eligible, targets: eligible }
    }
    case 'attribute_pair': {
      // source ต้องมี source_attribute, target ต้องมี target_attribute
      const srcAttr = scope.source_attribute!
      const tgtAttr = scope.target_attribute!
      return {
        sources: entities.filter((e) => srcAttr in e.attributes),
        targets: entities.filter((e) => tgtAttr in e.attributes),
      }
    }
    case 'attribute_range': {
      // source อยู่ใน min-max ของ target → ทุก entity เป็นได้ทั้งคู่
      return { sources: entities, targets: entities }
    }
    default:
      return { sources: [], targets: [] }
  }
}

// ─── Public API ──────────────────────────────────────────────────

export function runPairwise(
  rule: CompatibilityRule,
  entities: Entity[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // Pre-filter entities ตาม scope ก่อน — ลด pairs ที่ต้อง evaluate
  const { sources, targets } = getScopedPairs(rule, entities)

  for (const source of sources) {
    for (const target of targets) {
      if (source.id === target.id) continue

      const passed = evalLogic(rule.condition, { source, target })

      if (!passed) {
        // dedup: A→B กับ B→A แสดงแค่ครั้งเดียว
        const dup = issues.some(
          (iss) =>
            iss.rule_code === rule.code &&
            iss.detail?.source_entity === target.name &&
            iss.detail?.target_entity === source.name,
        )
        if (dup) continue

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
