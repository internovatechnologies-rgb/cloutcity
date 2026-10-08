/**
 * Player-facing text for the location action sheet (S09), built from what
 * src/engine/placeActions.ts reports, through the copy layer and the shared formatters.
 * Buttons stay plain ("Coffee: 15 min, $5"); flavour (the club door, results) uses the active
 * slang pack. Memorial copy is base-only and plain (src/lib/world/placeActions-content.test.ts).
 */
import { effectiveDuration } from '@/engine/actions'
import { engineConfig, type EngineConfig } from '@/engine/config'
import type { GameSnapshot } from '@/engine/game'
import { playerLevel } from '@/engine/clout'
import type {
  ClubDoor,
  PlaceAction,
  PlaceActionBlock,
  PlaceActionResult,
  PlaceHoursNow,
} from '@/engine/placeActions'
import type { StatChanges } from '@/engine/stats'
import { keyframeOfDay } from '@/lib/dayNight/keyframeOfDay'
import type { KeyframeId } from '@/lib/dayNight/types'
import { copy as activeCopy, isCopyKey, type CopyFn, type CopyKey } from '@/lib/copy'
import { cloutLevelName, jobLockedLabel, jobName } from '@/lib/economyCopy'
import { formatCount, formatMoney } from '@/lib/format'
import { boroughClosedReason, placeName, type MapPlace } from './places'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/club'
import '@/lib/copy/ns/place'

export interface PlaceActionCopyOptions {
  readonly copy?: CopyFn
  readonly config?: EngineConfig
}

type PlaceRef = Pick<MapPlace, 'id' | 'nameKey' | 'borough'>
/** A place, or null for the player's home (its rest and meal actions, S10a/B1). */
type ActionSpot = PlaceRef | null

const MINUTES_PER_HOUR = 60

function requireKey(key: string, what: string): CopyKey {
  if (!isCopyKey(key)) throw new Error(`No copy key "${key}" for ${what}`)
  return key
}

/** `street-meal` → `streetMeal`, the copy-key segment for a kebab-case id. */
function camelSegment(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, next: string) => next.toUpperCase())
}

/** Game minutes as "20 min", "4 h" or "1 h 30 min". */
export function formatDuration(
  minutes: number,
  { copy = activeCopy }: PlaceActionCopyOptions = {},
) {
  if (minutes < MINUTES_PER_HOUR)
    return copy('place.duration.minutes', { count: formatCount(minutes) })
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  const rest = minutes - hours * MINUTES_PER_HOUR
  return rest === 0
    ? copy('place.duration.hours', { count: formatCount(hours) })
    : copy('place.duration.hoursMinutes', {
        hours: formatCount(hours),
        minutes: formatCount(rest),
      })
}

/** The action's name: "Coffee", "Work a Barista shift", "Go in", "Visit", "Flex". */
export function placeActionName(action: PlaceAction, options: PlaceActionCopyOptions = {}) {
  const { copy = activeCopy } = options
  switch (action.kind) {
    case 'shift':
      return copy('place.actions.shift.name', { job: jobName(action.jobId, options) })
    case 'club-night':
      return copy('place.actions.clubNight.name')
    case 'visit':
      return copy('place.actions.visit.name')
    case 'flex':
      return copy('clout.flex.name')
    case 'consume':
      return copy(
        requireKey(`place.actions.${camelSegment(action.id)}.name`, `action ${action.id}`),
      )
  }
}

/**
 * Positive outcomes, in order: pay, stat gains, clout ("$56 pay", "+10 mood", "+10 clout").
 * `effects` are the action's configured effects on its button, or what really landed in a
 * result (a meal eaten nearly full adds less than it says on the button, GR-11).
 */
function gains(
  action: PlaceAction,
  cloutGained: number,
  { copy = activeCopy }: PlaceActionCopyOptions,
  effects: StatChanges = action.def.statEffects,
): string[] {
  const parts: string[] = []
  if (action.kind === 'shift')
    parts.push(copy('place.effect.pay', { pay: formatMoney(action.wage) }))
  const { energy = 0, hunger = 0, mood = 0 } = effects
  if (energy > 0) parts.push(copy('place.effect.energy', { count: formatCount(energy) }))
  if (hunger > 0) parts.push(copy('place.effect.hunger', { count: formatCount(hunger) }))
  if (mood > 0) parts.push(copy('place.effect.mood', { count: formatCount(mood) }))
  if (cloutGained > 0) parts.push(copy('place.effect.clout', { count: formatCount(cloutGained) }))
  return parts
}

/** Duration (with any tiredness slowdown), cost and what it gives: "15 min, $5, +10 energy". */
export function placeActionDetails(
  action: PlaceAction,
  snapshot: GameSnapshot,
  options: PlaceActionCopyOptions = {},
): string {
  const { copy = activeCopy, config = engineConfig } = options
  if (action.kind === 'flex') {
    return copy('clout.flex.details', {
      duration: formatDuration(effectiveDuration(action.def, snapshot, config), options),
      energy: formatCount(action.def.energyCost),
      count: formatCount(action.cloutGain),
    })
  }
  // Plain numbers, as on the flex row: time, then what it costs in cash and in energy (a cost of
  // nothing is left out rather than called "free"), then what it gives.
  const cost =
    action.kind === 'club-night'
      ? [copy('place.cost.cover', { price: formatMoney(action.coverCharge) })]
      : action.def.cashCost > 0
        ? [formatMoney(action.def.cashCost)]
        : []
  const energy =
    action.def.energyCost > 0
      ? [copy('place.cost.energy', { count: formatCount(action.def.energyCost) })]
      : []
  const clout = action.kind === 'club-night' ? action.cloutGain : 0
  return [
    formatDuration(effectiveDuration(action.def, snapshot, config), options),
    ...cost,
    ...energy,
    ...gains(action, clout, options),
    ...(action.kind === 'club-night' && action.cloutEarnedTonight
      ? [copy('place.effect.cloutEarnedTonight')]
      : []),
  ].join(', ')
}

/** Why an action cannot be done, in voice where it is flavour (the club door). */
export function placeBlockReason(
  block: PlaceActionBlock,
  place: ActionSpot,
  options: PlaceActionCopyOptions = {},
  action: PlaceAction | null = null,
): string {
  const { copy = activeCopy } = options
  switch (block.code) {
    case 'borough-locked':
      // An open borough never blocks, but if the access ever disagrees, say something plain.
      return (
        (place === null ? null : boroughClosedReason(place.borough, block.access, options)) ??
        copy('place.blocked.boroughLocked')
      )
    case 'closed':
      return copy('place.hours.closed', { time: block.opensAt })
    case 'door':
      return copy(requireKey(block.refusalKey, `club door ${place?.id ?? 'home'}`), {
        level: cloutLevelName(block.requiredLevel, options),
        current: cloutLevelName(block.currentLevel, options),
      })
    case 'job-locked':
      return jobLockedLabel(block.lock, options)
    case 'flexed-here-today':
      return copy('clout.flex.blocked.here')
    case 'flex-daily-limit':
      return copy('clout.flex.blocked.daily', { count: formatCount(block.max) })
    case 'away':
      return copy(place === null ? 'place.blocked.awayHome' : 'place.blocked.away')
    case 'funds':
      return copy('place.blocked.funds', {
        required: formatMoney(block.required),
        available: formatMoney(block.available),
      })
    case 'energy': {
      // Too tired: say where energy comes back (B1). At home that is the bed right there.
      const values = {
        required: formatCount(block.required),
        available: formatCount(block.available),
      }
      if (place === null) return copy('place.blocked.energyAtHome', values)
      return action?.kind === 'shift'
        ? copy('place.blocked.energyShift', values)
        : copy('place.blocked.energy', values)
    }
  }
}

/** The accessible name of an action button: its label, plus why it is blocked when it is. */
export function placeActionAccessibleName(
  action: PlaceAction,
  place: ActionSpot,
  snapshot: GameSnapshot,
  options: PlaceActionCopyOptions = {},
): string {
  const { copy = activeCopy } = options
  const label = copy('place.action.label', {
    name: placeActionName(action, options),
    details: placeActionDetails(action, snapshot, options),
  })
  return action.block === null
    ? label
    : copy('place.action.blockedLabel', {
        action: label,
        reason: placeBlockReason(action.block, place, options, action),
      })
}

/** A club's door rule, plainly, before the player travels there: "Door: Local clout and up". */
export function clubDoorLine(
  door: ClubDoor,
  snapshot: GameSnapshot,
  options: PlaceActionCopyOptions = {},
) {
  const { copy = activeCopy, config = engineConfig } = options
  return copy('place.club.door', {
    level: cloutLevelName(door.requiredLevel, options),
    current: cloutLevelName(playerLevel(snapshot.player, config).id, options),
  })
}

/** "Open 24 hours", "Open until 19:00" or "Closed. Opens at 22:00." on the personal clock. */
export function placeHoursLine(
  hours: PlaceHoursNow,
  { copy = activeCopy }: PlaceActionCopyOptions = {},
) {
  switch (hours.status) {
    case 'always':
      return copy('place.hours.always')
    case 'open':
      return copy('place.hours.open', { time: hours.closesAt })
    case 'closed':
      return copy('place.hours.closed', { time: hours.opensAt })
  }
}

/** What a finished action did, for the sheet's status line. */
export function placeActionDone(
  result: Extract<PlaceActionResult, { ok: true }>,
  place: ActionSpot,
  options: PlaceActionCopyOptions = {},
): string {
  const { copy = activeCopy } = options
  const effects = gains(result.action, result.cloutGained, options, result.statEffects).join(', ')
  switch (result.action.kind) {
    case 'shift':
      return copy('jobs.shift.done', { pay: formatMoney(result.wage) })
    case 'club-night':
      return result.action.cloutEarnedTonight
        ? copy('place.done.clubNightRepeat', { effects })
        : copy('place.done.clubNight', { effects })
    case 'visit':
      return place === null
        ? copy('place.done.consume', { effects })
        : copy('place.done.visit', { place: placeName(place, options), effects })
    case 'flex': {
      const count = formatCount(result.cloutGained)
      if (result.flex?.viral === true || place === null) return copy('clout.flex.viral', { count })
      // The light the fit was posted in: the S04f keyframe when the flex started.
      const started = result.snapshot.clock.minute - result.durationMin
      return copy('clout.flex.normal', {
        place: placeName(place, options),
        count,
        time: copy(FLEX_TIME_KEYS[keyframeOfDay(started)]),
      })
    }
    case 'consume':
      // Nothing landed (already full and rested): no empty list after "Done".
      return effects === '' ? copy('place.done.plain') : copy('place.done.consume', { effects })
  }
}

/** The time-of-day phrase of a flex, per day/night keyframe (S04f). */
const FLEX_TIME_KEYS = {
  dawn: 'clout.flex.time.dawn',
  morning: 'clout.flex.time.morning',
  day: 'clout.flex.time.day',
  golden: 'clout.flex.time.golden',
  dusk: 'clout.flex.time.dusk',
  night: 'clout.flex.time.night',
} as const satisfies Record<KeyframeId, CopyKey>
