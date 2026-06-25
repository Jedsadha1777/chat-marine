import { BacktrackFillStrategy } from './backtrack'
import type { FillStrategy } from './types'

const _registry = new Map<string, FillStrategy>([
  ['backtrack', new BacktrackFillStrategy()],
])

export function getStrategy(name?: string): FillStrategy {
  const key = name ?? 'backtrack'
  const strategy = _registry.get(key)
  if (!strategy) throw new Error(`Unknown fill strategy: '${key}'. Available: ${[..._registry.keys()].join(', ')}`)
  return strategy
}

export function registerStrategy(name: string, strategy: FillStrategy): void {
  _registry.set(name, strategy)
}

export type { FillStrategy, FillInput } from './types'
