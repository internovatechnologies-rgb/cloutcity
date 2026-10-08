/**
 * Player-facing text for the first-run tour (S06): each step's line, with the place, its action
 * and the cash the purchase moved filled in from data, the engine and the shared formatters.
 */
import { engineConfig } from '@/engine/config'
import type { GameSnapshot } from '@/engine/game'
import { placeActions } from '@/engine/placeActions'
import type { ActiveTour, TourStep, TourTarget } from '@/state/tour'
import { copy as activeCopy, type CopyFn, type CopyKey } from './copy'
import { formatMoney } from './format'
import { placeActionName } from './world/placeActionCopy'
import { findPlace, placeName } from './world/places'
import { tripModeAction } from './world/travelCopy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/tour'

export interface TourCopyOptions {
  readonly copy?: CopyFn
  /**
   * Whether the player stands at the tour's place (S08, DEC-22). Away, the purchase step first
   * points at walking there, in the same step.
   */
  readonly here?: boolean
}

/** The names the tour shows for its target: the place, and the action bought there. */
export interface TourNames {
  readonly place: string
  readonly action: string
}

/**
 * The target's display names. Throws when tour.json names a place or action the data does not
 * have (src/lib/data/data.test.ts checks it, so this is a build bug, never a player's state).
 */
export function tourNames(
  target: TourTarget,
  snapshot: GameSnapshot,
  options: TourCopyOptions = {},
): TourNames {
  const place = findPlace(target.placeId)
  if (place === undefined) throw new Error(`The tour's place "${target.placeId}" does not exist`)
  const view = placeActions(place, snapshot, engineConfig)
  const action =
    view.kind === 'look-only'
      ? undefined
      : view.actions.find((candidate) => candidate.id === target.actionId)
  if (action === undefined) {
    throw new Error(`The tour's place "${target.placeId}" has no action "${target.actionId}"`)
  }
  return { place: placeName(place, options), action: placeActionName(action, options) }
}

const STEP_KEYS: Readonly<Record<TourStep, CopyKey>> = {
  hud: 'tour.step.hud',
  find: 'tour.step.find',
  pick: 'tour.step.pick',
  buy: 'tour.step.buy',
  cash: 'tour.step.cash',
  done: 'tour.step.done',
}

/** The line a step shows. */
export function tourStepText(
  record: ActiveTour,
  names: TourNames,
  options: TourCopyOptions = {},
): string {
  const { copy = activeCopy, here = true } = options
  const key = STEP_KEYS[record.step]
  switch (record.step) {
    case 'pick':
      return copy(key, { place: names.place })
    case 'buy':
      return here
        ? copy(key, { action: names.action })
        : copy('tour.step.buyAway', {
            walk: tripModeAction('walk', { copy }),
            action: names.action,
          })
    case 'cash': {
      // The cash step always carries its receipt (src/state/tour.ts); without one there is
      // nothing true to say about the purchase, so the line falls back to the last step's.
      if (record.receipt === null) return copy(STEP_KEYS.done)
      return copy(key, {
        before: formatMoney(record.receipt.before),
        after: formatMoney(record.receipt.after),
      })
    }
    default:
      return copy(key)
  }
}
