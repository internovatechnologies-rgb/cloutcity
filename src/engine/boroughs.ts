/**
 * Borough gating. The rules live in data/config/balance.json `boroughs`: a borough is open to
 * everyone, opens at a clout level, or is "expanding soon" (not playable yet at any level).
 * A locked result carries both level ids so the UI can say why in voice (and in the
 * accessible name).
 */
import type { Borough } from '@/lib/data/schemas/content'
import { cloutLevel, findCloutLevel } from './clout'
import type { EngineConfig } from './config'

export type BoroughAccess =
  | { readonly status: 'open' }
  | {
      readonly status: 'locked'
      /** The `clout.levels` id the borough opens at. */
      readonly required: string
      /** The player's current level id. */
      readonly current: string
    }
  | { readonly status: 'expanding-soon' }

/** Whether a player with `clout` may enter `borough`. */
export function boroughAccess(
  borough: Borough,
  clout: number,
  config: EngineConfig,
): BoroughAccess {
  const rule = config.boroughs[borough]
  switch (rule.access) {
    case 'open':
      return { status: 'open' }
    case 'expanding-soon':
      return { status: 'expanding-soon' }
    case 'clout': {
      const required = findCloutLevel(rule.level, config)
      if (required === undefined) {
        throw new Error(`boroughs.${borough}: unknown clout level "${rule.level}"`)
      }
      const current = cloutLevel(clout, config)
      return current.index >= required.index
        ? { status: 'open' }
        : { status: 'locked', required: required.id, current: current.id }
    }
  }
}

/**
 * Whether a player with `clout` may go to the place with `placeId` in `borough`: its borough's
 * access, except that a memorial is open to everyone (DEC-46: a memorial is never locked behind
 * clout or held out as a reward). The category comes from `config.places`, never the caller.
 */
export function placeBoroughAccess(
  placeId: string,
  borough: Borough,
  clout: number,
  config: EngineConfig,
): BoroughAccess {
  if (config.places.get(placeId) === 'memorial') return { status: 'open' }
  return boroughAccess(borough, clout, config)
}

/** `boroughAccess` for every borough. */
export function boroughAccessAll(
  clout: number,
  config: EngineConfig,
): Readonly<Record<Borough, BoroughAccess>> {
  return {
    queens: boroughAccess('queens', clout, config),
    brooklyn: boroughAccess('brooklyn', clout, config),
    manhattan: boroughAccess('manhattan', clout, config),
    bronx: boroughAccess('bronx', clout, config),
    'staten-island': boroughAccess('staten-island', clout, config),
  }
}
