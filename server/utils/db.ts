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
  // unit_cost column is canonical — overwrite attributes field which may be stale or missing.
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

export async function fetchCheapestCandidates(
  DB: D1Database,
  type: string,
  maxCost: number,
  blockedIds: number[],
  limit = 10,
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

  sql += ` ORDER BY unit_cost ASC LIMIT ?`
  params.push(limit)

  const { results } = await DB.prepare(sql).bind(...params).all<Record<string, unknown>>()
  return results.map(rowToEntity)
}

// No LIMIT — pairwise filtering must never silently drop compatible options beyond position N.
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

export async function fetchByIds(DB: D1Database, ids: number[]): Promise<Entity[]> {
  if (ids.length === 0) return []
  const sql = `
    SELECT id, uuid, entity_type, code, name, status, unit_cost, attributes
    FROM entities WHERE id IN (${ids.map(() => '?').join(',')})
  `
  const { results } = await DB.prepare(sql).bind(...ids).all<Record<string, unknown>>()
  return results.map(rowToEntity)
}
