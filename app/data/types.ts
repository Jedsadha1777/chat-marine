// ─────────────────────────────────────────────
// Entity
// ─────────────────────────────────────────────

export interface EntityAttributes {
  // CPU
  socket?: string
  cores?: number
  tdp_w?: number
  ram_type?: string | string[]
  pcie_version?: string
  integrated_gpu?: boolean
  // Motherboard
  ram_slots?: number
  max_ram_gb?: number
  max_ram_speed_mhz?: number
  tdp_support_w?: number
  power_draw_w?: number
  // RAM
  modules?: number
  speed_mhz?: number
  // GPU
  // PSU
  watt_output?: number
  efficiency?: string
  // Generic
  weight_kg?: number
  unit_cost?: number
  [key: string]: unknown
}

export interface Entity {
  id: number
  uuid: string
  entity_type: string
  code: string
  name: string
  status: 'draft' | 'published' | 'archived' | 'deprecated'
  attributes: EntityAttributes
}

// ─────────────────────────────────────────────
// Compatibility Rule
// ─────────────────────────────────────────────

export type CheckType = 'pairwise' | 'aggregate'
export type Severity  = 'error' | 'warning' | 'info'

export interface PairwiseScope {
  match_by: 'shared_attribute' | 'attribute_pair' | 'attribute_range'
  attribute_key?: string
  source_attribute?: string
  target_attribute?: string
}

export interface AggregateConfig {
  function: 'sum' | 'count' | 'max' | 'min' | 'avg'
  attribute: string
  fallback_attributes?: string[]
  from_types: string[]
  exclude_types?: string[]
  multiply_by_quantity?: boolean
}

export interface CompareTo {
  mode: 'entity_attribute' | 'simulation_constraint' | 'fixed_value'
  entity_type?: string
  attribute?: string
  constraint_key?: string
  value?: number
  safety_factor?: number
}

export interface AggregateCondition {
  aggregate: AggregateConfig
  compare_to: CompareTo
  operator: '<=' | '>=' | '<' | '>' | '=='
}

export interface CompatibilityRule {
  id: number
  code: string
  name: string
  check_type: CheckType
  severity: Severity
  condition: Record<string, unknown> | AggregateCondition
  scope?: PairwiseScope
  message: string
  resolution?: string
  is_active: boolean
  priority: number
}

// ─────────────────────────────────────────────
// Simulation
// ─────────────────────────────────────────────

export interface SimulationItem {
  id: number
  entity: Entity
  quantity: number
  slot_key?: string
}

export interface ValidationIssue {
  rule_code: string
  check_type: CheckType
  severity: Severity
  message: string
  resolution?: string
  detail?: {
    aggregate_value?: number
    capacity_value?: number
    utilization_pct?: number
    source_entity?: string
    target_entity?: string
  }
}

export interface ValidationResult {
  is_valid: boolean
  issues: ValidationIssue[]
}

// ─────────────────────────────────────────────
// BOM
// ─────────────────────────────────────────────

export interface BomItem {
  line_number: number
  entity: Entity
  quantity: number
  unit_cost: number
  total_cost: number
}
