import type { DomainConfig } from '~/engine/suggest'
import { ENTITY_TYPES, ENTITY_TYPE_LABELS } from '~/data/entityTypes'
import {
  FILL_ORDER, MAX_PER_TYPE, DYNAMIC_MAX_PER_TYPE,
  AGGREGATE_GUARD_TYPES, AGGREGATE_DISPLAY, REQUIRED_TYPES,
  COST_ATTRIBUTE, COST_PRECISION, CAPACITY_FACTOR, SELECTION_ORDER,
} from '~/composables/simulationConfig'
import { TIER_RULES } from '~/composables/tierRules'

export const DEFAULT_DOMAIN_CONFIG: DomainConfig = {
  fillOrder:         [...FILL_ORDER],
  entityTypes:       [...ENTITY_TYPES],
  entityTypeLabels:  { ...ENTITY_TYPE_LABELS },
  maxPerType:        { ...MAX_PER_TYPE },
  dynamicMaxPerType: { ...DYNAMIC_MAX_PER_TYPE },
  aggregateGuardTypes: [...AGGREGATE_GUARD_TYPES],
  aggregateDisplay:  { ...AGGREGATE_DISPLAY },
  requiredTypes:     [...REQUIRED_TYPES],
  costAttribute:     COST_ATTRIBUTE,
  costPrecision:     COST_PRECISION,
  tierRules:         [...TIER_RULES],
  anchorType:        'gpu',
  capacityType:      'psu',
  capacityAttribute: 'watt_output',
  loadAttributes:    ['power_draw_w', 'tdp_w'],
  capacityFactor:    CAPACITY_FACTOR,
  selectionOrder:    [...SELECTION_ORDER],
}
