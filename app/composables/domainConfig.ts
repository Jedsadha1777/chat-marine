import type { DomainConfig } from '~/engine/suggest'
import { ENTITY_TYPES, ENTITY_TYPE_LABELS } from '~/data/entities'
import {
  FILL_ORDER, MAX_PER_TYPE, DYNAMIC_MAX_PER_TYPE,
  QUANTITY_MODE, QUANTITY_MODE_PER_TYPE, SELECTION_STRATEGY, SELECTION_STRATEGY_PER_TYPE,
  BUDGET_FLOOR_PER_TYPE, HARD_FLOOR_MIN, STACK_DISTRIBUTE_MODE,
  AGGREGATE_GUARD_TYPES, AGGREGATE_DISPLAY, REQUIRED_TYPES,
  COST_ATTRIBUTE, COST_PRECISION, UPGRADE_ORDER,
} from '~/composables/simulationConfig'

export const DEFAULT_DOMAIN_CONFIG: DomainConfig = {
  fillOrder:                [...FILL_ORDER],
  entityTypes:              [...ENTITY_TYPES],
  entityTypeLabels:         { ...ENTITY_TYPE_LABELS },
  maxPerType:               { ...MAX_PER_TYPE },
  dynamicMaxPerType:        { ...DYNAMIC_MAX_PER_TYPE },
  quantityMode:             QUANTITY_MODE,
  quantityModePerType:      { ...QUANTITY_MODE_PER_TYPE },
  selectionStrategy:        SELECTION_STRATEGY,
  selectionStrategyPerType: { ...SELECTION_STRATEGY_PER_TYPE },
  budgetFloorPerType:       { ...BUDGET_FLOOR_PER_TYPE },
  hardFloorMin:             { ...HARD_FLOOR_MIN },
  stackDistributeMode:      STACK_DISTRIBUTE_MODE,
  aggregateGuardTypes:      [...AGGREGATE_GUARD_TYPES],
  aggregateDisplay:         { ...AGGREGATE_DISPLAY },
  requiredTypes:            [...REQUIRED_TYPES],
  costAttribute:            COST_ATTRIBUTE,
  costPrecision:            COST_PRECISION,
  upgradeOrder:             [...UPGRADE_ORDER],
}
