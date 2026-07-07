import type { D1Database } from '@cloudflare/workers-types'
import type { Entity } from '~/data/types'

export interface DbConfig {
  costColumn:      string
  publishedStatus: string
}

export const DEFAULT_DB_CONFIG: DbConfig = {
  costColumn:      'unit_cost',
  publishedStatus: 'published',
}

export function dbConfigFrom(src: { costColumn?: string; publishedStatus?: string }): DbConfig {
  return {
    costColumn:      src.costColumn      ?? DEFAULT_DB_CONFIG.costColumn,
    publishedStatus: src.publishedStatus ?? DEFAULT_DB_CONFIG.publishedStatus,
  }
}

function safeSqlId(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`)
  return name
}

export function rowToEntity(row: Record<string, unknown>, costColumn = 'unit_cost'): Entity {
  const attributes = JSON.parse(row.attributes as string)
  attributes[costColumn] = row[costColumn]
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
  limit = 15,
  dbCfg: DbConfig = DEFAULT_DB_CONFIG,
): Promise<Entity[]> {
  const col = safeSqlId(dbCfg.costColumn)
  const sql = `
    SELECT id, uuid, entity_type, code, name, status, ${col}, attributes
    FROM entities
    WHERE entity_type = ? AND status = ? AND ${col} <= ?
    ORDER BY ${col} DESC LIMIT ?
  `
  const params: unknown[] = [type, dbCfg.publishedStatus, maxCost, limit]

  const { results } = await DB.prepare(sql).bind(...params).all<Record<string, unknown>>()
  return results.map((r) => rowToEntity(r, dbCfg.costColumn))
}

export async function fetchCheapestCandidates(
  DB: D1Database,
  type: string,
  maxCost: number,
  limit = 10,
  dbCfg: DbConfig = DEFAULT_DB_CONFIG,
): Promise<Entity[]> {
  const col = safeSqlId(dbCfg.costColumn)
  const sql = `
    SELECT id, uuid, entity_type, code, name, status, ${col}, attributes
    FROM entities
    WHERE entity_type = ? AND status = ? AND ${col} <= ?
    ORDER BY ${col} ASC LIMIT ?
  `
  const params: unknown[] = [type, dbCfg.publishedStatus, maxCost, limit]

  const { results } = await DB.prepare(sql).bind(...params).all<Record<string, unknown>>()
  return results.map((r) => rowToEntity(r, dbCfg.costColumn))
}

export async function fetchPickerCandidates(
  DB: D1Database,
  type: string,
  maxCost: number,
  dbCfg: DbConfig = DEFAULT_DB_CONFIG,
  limit = 500,
): Promise<Entity[]> {
  const col = safeSqlId(dbCfg.costColumn)
  const sql = `
    SELECT id, uuid, entity_type, code, name, status, ${col}, attributes
    FROM entities
    WHERE entity_type = ? AND status = ? AND ${col} <= ?
    ORDER BY ${col} ASC LIMIT ?
  `
  const params: unknown[] = [type, dbCfg.publishedStatus, maxCost, limit]

  const { results } = await DB.prepare(sql).bind(...params).all<Record<string, unknown>>()
  return results.map((r) => rowToEntity(r, dbCfg.costColumn))
}

export async function fetchAllCandidates(
  DB: D1Database,
  type: string,
  dbCfg: DbConfig = DEFAULT_DB_CONFIG,
  limit = 1000,
): Promise<Entity[]> {
  const col = safeSqlId(dbCfg.costColumn)
  const sql = `
    SELECT id, uuid, entity_type, code, name, status, ${col}, attributes
    FROM entities
    WHERE entity_type = ? AND status = ?
    ORDER BY ${col} ASC LIMIT ?
  `
  const { results } = await DB.prepare(sql).bind(type, dbCfg.publishedStatus, limit).all<Record<string, unknown>>()
  return results.map((r) => rowToEntity(r, dbCfg.costColumn))
}

export async function fetchByIds(
  DB: D1Database,
  ids: number[],
  dbCfg: DbConfig = DEFAULT_DB_CONFIG,
): Promise<Entity[]> {
  if (ids.length === 0) return []
  const col = safeSqlId(dbCfg.costColumn)
  const sql = `
    SELECT id, uuid, entity_type, code, name, status, ${col}, attributes
    FROM entities WHERE id IN (${ids.map(() => '?').join(',')})
  `
  const { results } = await DB.prepare(sql).bind(...ids).all<Record<string, unknown>>()
  return results.map((r) => rowToEntity(r, dbCfg.costColumn))
}
