import type { DomainConfig } from '~/engine/suggest'
import { ENTITY_TYPES, ENTITY_TYPE_LABELS } from '~/data/entityTypes'
import type { EntityType } from '~/data/entityTypes'
import { TIER_RULES } from '~/composables/tierRules'

// BOM display order — SSD shown above PSU
export const FILL_ORDER: EntityType[] = ['gpu', 'cpu', 'motherboard', 'ram', 'ssd', 'psu']

export const MAX_PER_TYPE: Partial<Record<EntityType, number>> = {
  gpu:         1,
  cpu:         1,
  motherboard: 1,
  psu:         1,
  ssd:         1,
}

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

// Phase 1 runs before RAM x2 (guarantees at least 1 SSD); phase 3 runs after (upgrade only).
export const POST_FILL_TYPES: Array<{
  type: EntityType
  preferAttribute: string
  maxAttrValue?: number
  minAttrValue?: number
  upgradeExisting?: boolean
}> = [
  { type: 'ssd', preferAttribute: 'capacity_gb', maxAttrValue: 512 },
  { type: 'ssd', preferAttribute: 'capacity_gb', minAttrValue: 1000, upgradeExisting: true },
]

export const AGGREGATE_GUARD_TYPES: EntityType[] = ['psu', 'ram']

export const AGGREGATE_DISPLAY: { primary: string; safety: string | null } = {
  primary: 'AGG_POWER_CAPACITY',
  safety:  'AGG_POWER_SAFETY',
}

export const REQUIRED_TYPES: EntityType[] = ['cpu', 'motherboard', 'ram', 'psu']

// CPU → RAM → MB so MB adapts to whichever RAM wins (DDR5 kit or DDR4), not the other way round.
export const SELECTION_ORDER: EntityType[] = ['cpu', 'ram', 'motherboard', 'psu']

export const CAPACITY_FACTOR = 0.8

export const COST_ATTRIBUTE = 'unit_cost'
export const COST_PRECISION = 0

export const DEFAULT_DOMAIN_CONFIG: DomainConfig = {
  fillOrder:           [...FILL_ORDER],
  entityTypes:         [...ENTITY_TYPES],
  entityTypeLabels:    { ...ENTITY_TYPE_LABELS },
  maxPerType:          { ...MAX_PER_TYPE },
  dynamicMaxPerType:   { ...DYNAMIC_MAX_PER_TYPE },
  aggregateGuardTypes: [...AGGREGATE_GUARD_TYPES],
  aggregateDisplay:    { ...AGGREGATE_DISPLAY },
  requiredTypes:       [...REQUIRED_TYPES],
  costAttribute:       COST_ATTRIBUTE,
  costPrecision:       COST_PRECISION,
  tierRules:           [...TIER_RULES],
  anchorType:          'gpu',
  capacityType:        'psu',
  capacityAttribute:   'watt_output',
  loadAttributes:      ['power_draw_w', 'tdp_w'],
  capacityFactor:      CAPACITY_FACTOR,
  selectionOrder:      [...SELECTION_ORDER],
  postFillTypes:       [...POST_FILL_TYPES],
}
