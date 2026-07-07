import { createError } from 'h3'

const MAX_LOOKUP_IDS   = 50
const MAX_PINNED_ITEMS = 10
const MAX_QUANTITY     = 8

export function parseBudget(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw createError({ statusCode: 400, message: 'budget must be a positive finite number or null' })
  }
  return n
}

export function parseEntityType(raw: unknown, validTypes: string[]): string {
  if (typeof raw !== 'string' || !validTypes.includes(raw)) {
    throw createError({ statusCode: 400, message: `Unknown entity type: ${String(raw)}` })
  }
  return raw
}

// Returns at most maxLen positive-integer IDs. Rejects non-integer values.
export function parseIds(raw: unknown, maxLen: number): number[] {
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).slice(0, maxLen).map((x) => {
    const n = Number(x)
    if (!Number.isInteger(n) || n <= 0) {
      throw createError({ statusCode: 400, message: `Invalid ID value: ${x}` })
    }
    return n
  })
}

export function parseLookupIds(raw: unknown): number[] {
  return parseIds(raw, MAX_LOOKUP_IDS)
}

export function parsePinned(
  raw: unknown,
  validTypes: string[],
): Record<string, Array<{ id: number; quantity: number }>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, Array<{ id: number; quantity: number }>> = {}
  for (const [type, items] of Object.entries(raw as Record<string, unknown>)) {
    if (!validTypes.includes(type) || !Array.isArray(items)) continue
    result[type] = (items as unknown[]).slice(0, MAX_PINNED_ITEMS).map((item) => {
      if (!item || typeof item !== 'object') {
        throw createError({ statusCode: 400, message: 'Invalid pinned item' })
      }
      const { id, quantity } = item as Record<string, unknown>
      const nId = Number(id)
      if (!Number.isInteger(nId) || nId <= 0) {
        throw createError({ statusCode: 400, message: `Invalid pinned ID: ${id}` })
      }
      return { id: nId, quantity: Math.min(Math.max(1, Number(quantity) || 1), MAX_QUANTITY) }
    })
  }
  return result
}
