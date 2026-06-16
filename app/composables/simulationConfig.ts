import type { EntityType } from '~/data/entities'

// BOM display order — SSD shown above PSU
export const FILL_ORDER: EntityType[] = ['gpu', 'cpu', 'motherboard', 'ram', 'ssd', 'psu']

// Hard max per slot type (undefined = unlimited)
export const MAX_PER_TYPE: Partial<Record<EntityType, number>> = {
  gpu:         1,
  cpu:         1,
  motherboard: 1,
  psu:         1,
  ssd:         1,
}

// Dynamic limit sourced from another entity's attribute
export const DYNAMIC_MAX_PER_TYPE: Partial<Record<EntityType, {
  source_type:        EntityType
  source_attribute:   string
  capacity_attribute?: string
  fallback:           number
}>> = {
  ram: {
    source_type:        'motherboard',
    source_attribute:   'ram_slots',
    capacity_attribute: 'modules',
    fallback:           2,
  },
}

// Post-fill types: filled after main package (anchor+core) using remaining budget.
// Sorted by preferAttribute DESC so biggest-affordable wins.
export const POST_FILL_TYPES: Array<{ type: EntityType; preferAttribute: string }> = [
  { type: 'ssd', preferAttribute: 'capacity_gb' },
]

// Slots that need aggregate rule check (capacity containers)
export const AGGREGATE_GUARD_TYPES: EntityType[] = ['psu', 'ram']

// Rule codes used for power-draw display in UI
export const AGGREGATE_DISPLAY: { primary: string; safety: string | null } = {
  primary: 'AGG_POWER_CAPACITY',
  safety:  'AGG_POWER_SAFETY',
}

// Types required in every valid build
export const REQUIRED_TYPES: EntityType[] = ['cpu', 'motherboard', 'ram', 'psu']

// Engine selection priority (non-GPU components). Order = budget allocation priority.
// RAM first → maximize capacity; then CPU quality; then MB quality; PSU always cheapest adequate.
export const SELECTION_ORDER: EntityType[] = ['ram', 'cpu', 'motherboard', 'psu']

// Safety factor — total load must not exceed this fraction of capacity entity's capacity attribute
export const CAPACITY_FACTOR = 0.8

export const COST_ATTRIBUTE = 'unit_cost'
export const COST_PRECISION = 0
