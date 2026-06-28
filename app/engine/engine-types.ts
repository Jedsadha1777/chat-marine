import type { CompatibilityRule, Entity } from '~/data/types'
import type { Module } from './ruleflow/index'

export interface TierRule {
  name: string
  provider: { entity_type: string; condition: Record<string, unknown> }
  requires: Array<{ entity_type: string; condition: Record<string, unknown> }>
}

export interface DynMaxSourceEntry {
  source_type:      string
  source_attribute: string
}

export interface DynMaxSources {
  sources:            DynMaxSourceEntry[]
  aggregate:          'min' | 'max' | 'sum'
  capacity_attribute?: string
  sort_attribute?:    string
  fallback:           number
}

export interface DynMaxFormula {
  formula:            string          // RuleFlow expr; vars = {type}_{attribute} from suggestion
  capacity_attribute?: string
  sort_attribute?:    string
  fallback:           number
}

export type DynamicMaxCfg = DynMaxSources | DynMaxFormula

export interface PostFillCfg {
  type:              string
  preferAttribute?:  string
  maxAttrValue?:     number
  minAttrValue?:     number
  upgradeExisting?:  boolean
}

export interface FetchLimits {
  anchor:     number
  anchorNear: number
  capacity:   number
  core:       number
  coreCheap:  number
}

export interface DomainConfig {
  fillOrder:           string[]
  entityTypes:         string[]
  entityTypeLabels:    Record<string, string>
  maxPerType:          Partial<Record<string, number>>
  dynamicMaxPerType:   Partial<Record<string, DynamicMaxCfg>>
  aggregateGuardTypes: string[]
  aggregateDisplay:    { primary: string; safety: string | null }
  requiredTypes:       string[]
  costAttribute:       string
  costPrecision:       number
  rules:               CompatibilityRule[]
  tierRules?:          TierRule[]
  anchorType?:         string
  selectionOrder?:     string[]
  capacityType?:       string
  capacityAttribute?:  string
  loadAttributes?:     string[]
  capacityFactor?:     number
  postFillTypes?:      PostFillCfg[]
  fetchLimits?:        FetchLimits
  fillStrategy?:       string
  budgetPlan?:         Module
  publishedStatus?:    string
  costColumn?:         string
}

export interface SlotItem {
  entity:   Entity
  quantity: number
}

export interface SuggestInput {
  budget:     number | null
  pinned?:    Partial<Record<string, SlotItem[]>>
  excluded?:  Partial<Record<string, boolean>>
  blockedIds?: Iterable<number>
}

export interface SuggestResult {
  slots:    Record<string, SlotItem[]>
  overflow: boolean
}
