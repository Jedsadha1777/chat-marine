import type { D1Database } from '@cloudflare/workers-types'
import type { Entity } from '~/data/types'

export interface EntityRow {
  id: number
  uuid: string
  entity_type: string
  code: string
  name: string
  status: string
  unit_cost: number
  attributes: string
}

export function rowToEntity(row: Record<string, unknown>): Entity {
  const attributes = JSON.parse(row.attributes as string)
  // unit_cost column is the canonical value — sync into attributes so the engine
  // always reads the correct price even if the JSON field is missing or stale.
  attributes['unit_cost'] = row.unit_cost
  return {
    id:          row.id as number,
    uuid:        row.uuid as string,
    entity_type: row.entity_type as string,
    code:        row.code as string,
    name:        row.name as string,
    status:      row.status as Entity['status'],
    attributes,
  }
}

// Fetch top-N candidates for the engine — most expensive first so backtracking
// can descend toward cheaper options. LIMIT keeps the in-memory set small.
export async function fetchCandidates(
  DB: D1Database,
  type: string,
  maxCost: number,
  blockedIds: number[],
  limit = 15,
): Promise<Entity[]> {
  let sql = `
    SELECT id, uuid, entity_type, code, name, status, unit_cost, attributes
    FROM entities
    WHERE entity_type = ? AND status = 'published' AND unit_cost <= ?
  `
  const params: unknown[] = [type, maxCost]

  if (blockedIds.length > 0) {
    sql += ` AND id NOT IN (${blockedIds.map(() => '?').join(',')})`
    params.push(...blockedIds)
  }

  sql += ` ORDER BY unit_cost DESC LIMIT ?`
  params.push(limit)

  const { results } = await DB.prepare(sql).bind(...params).all<Record<string, unknown>>()
  return results.map(rowToEntity)
}

// Fetch ALL candidates within budget for the picker UI — no LIMIT so pairwise
// filtering never silently drops compatible options that sit beyond position N.
// Ordered cheapest-first so the picker shows affordable options at the top.
export async function fetchPickerCandidates(
  DB: D1Database,
  type: string,
  maxCost: number,
  blockedIds: number[],
): Promise<Entity[]> {
  let sql = `
    SELECT id, uuid, entity_type, code, name, status, unit_cost, attributes
    FROM entities
    WHERE entity_type = ? AND status = 'published' AND unit_cost <= ?
  `
  const params: unknown[] = [type, maxCost]

  if (blockedIds.length > 0) {
    sql += ` AND id NOT IN (${blockedIds.map(() => '?').join(',')})`
    params.push(...blockedIds)
  }

  sql += ` ORDER BY unit_cost ASC`

  const { results } = await DB.prepare(sql).bind(...params).all<Record<string, unknown>>()
  return results.map(rowToEntity)
}

// Fetch candidates filtered by a JSON attribute value.
// Used when pairwise compatibility constraints (e.g. DDR4 RAM requiring a DDR4 MB)
// push compatible-but-cheap options beyond the LIMIT of the general top-N query.
export async function fetchCandidatesByAttr(
  DB: D1Database,
  type: string,
  jsonPath: string,   // e.g. '$.ram_type'
  attrValue: string,  // e.g. 'DDR4'
  maxCost: number,
  blockedIds: number[],
  limit = 10,
): Promise<Entity[]> {
  let sql = `
    SELECT id, uuid, entity_type, code, name, status, unit_cost, attributes
    FROM entities
    WHERE entity_type = ? AND status = 'published' AND unit_cost <= ?
      AND json_extract(attributes, ?) = ?
  `
  const params: unknown[] = [type, maxCost, jsonPath, attrValue]

  if (blockedIds.length > 0) {
    sql += ` AND id NOT IN (${blockedIds.map(() => '?').join(',')})`
    params.push(...blockedIds)
  }

  sql += ` ORDER BY unit_cost DESC LIMIT ?`
  params.push(limit)

  const { results } = await DB.prepare(sql).bind(...params).all<Record<string, unknown>>()
  return results.map(rowToEntity)
}

// Fetch specific entities by IDs (for pinned items).
export async function fetchByIds(DB: D1Database, ids: number[]): Promise<Entity[]> {
  if (ids.length === 0) return []
  const sql = `
    SELECT id, uuid, entity_type, code, name, status, unit_cost, attributes
    FROM entities WHERE id IN (${ids.map(() => '?').join(',')})
  `
  const { results } = await DB.prepare(sql).bind(...ids).all<Record<string, unknown>>()
  return results.map(rowToEntity)
}
