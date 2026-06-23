import type { DomainConfig } from '~/engine/suggest'
import domainJson from './pc-builder.json'

export const DOMAIN: DomainConfig = domainJson as unknown as DomainConfig

// Convenience re-exports for consumers that reference specific fields directly
export const ENTITY_TYPES        = DOMAIN.entityTypes
export const ENTITY_TYPE_LABELS  = DOMAIN.entityTypeLabels
export const FILL_ORDER          = DOMAIN.fillOrder
export const REQUIRED_TYPES      = DOMAIN.requiredTypes
export const COST_ATTRIBUTE      = DOMAIN.costAttribute
export const COST_PRECISION      = DOMAIN.costPrecision

export type EntityType = string
