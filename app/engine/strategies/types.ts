import type { Entity } from '~/data/types'
import type { DomainConfig, SlotItem } from '../engine-types'

export interface FillInput {
  entities:   Entity[]
  cfg:        DomainConfig
  budget:     number
  pinned:     Record<string, SlotItem[]>
  excluded:   Record<string, boolean>
  blockedIds: Set<number>
}

export interface FillStrategy {
  fill(input: FillInput): Record<string, SlotItem[]>
}
