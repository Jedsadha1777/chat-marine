export const ENTITY_TYPES = ['motherboard', 'cpu', 'ram', 'gpu', 'psu', 'ssd'] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  motherboard: 'Motherboard',
  cpu:         'CPU',
  ram:         'RAM',
  gpu:         'GPU',
  psu:         'PSU',
  ssd:         'SSD M.2',
}
