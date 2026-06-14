import { evalLogic } from '~/engine/pairwise'
import type { Entity } from '~/data/types'

export interface TierRule {
  name: string
  provider: { entity_type: string; condition: Record<string, unknown> }
  requires: Array<{ entity_type: string; condition: Record<string, unknown> }>
}

export function getTierConditions(
  provider: Entity,
  rules: TierRule[],
  requiredType: string,
): Record<string, unknown>[] {
  return rules
    .filter(r =>
      r.provider.entity_type === provider.entity_type &&
      evalLogic(r.provider.condition, { attributes: provider.attributes })
    )
    .flatMap(r =>
      r.requires.filter(req => req.entity_type === requiredType).map(req => req.condition)
    )
}

export const TIER_RULES: TierRule[] = [
  {
    name: 'HIGH_BW_GPU_REQUIRES_HIGH_CACHE_CPU',
    provider: {
      entity_type: 'gpu',
      condition: {
        and: [
          { '>': [{ var: 'attributes.memory_bus_bit' }, 312] },
          { '>': [{ var: 'attributes.vram_gb' }, 16] },
        ],
      },
    },
    requires: [
      {
        entity_type: 'cpu',
        condition: { '>': [{ var: 'attributes.l3_cache_mb' }, 32] },
      },
    ],
  },
]
