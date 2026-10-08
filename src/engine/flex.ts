/**
 * Flexing (S13): posting a fit at a landmark or a boutique for clout. Never at a club:
 * nightlife is flavour only (the balance schema keeps `club` out of `clout.flex.venueTypes`).
 *
 * - Where: a landmark that allows `flex` (its `place.flexMultiplier`, or the default), or a
 *   venue whose type is in `clout.flex.venueTypes` (the default multiplier). Never a memorial:
 *   memorials allow nothing (`placeAllows`), so they have no multiplier and no Flex action.
 * - How often: once per place per game day, and at most `clout.flex.maxPerGameDay` a day.
 * - What it costs: `clout.flex` duration, energy and cash, like any action.
 * - What it earns: `baseClout`, or `baseClout * viral.cloutMultiplier` when it goes viral,
 *   scaled by the place multiplier and the outfit's style (src/engine/clout.ts `scaledGain`).
 * - Going viral: exactly one seeded draw (src/engine/rng.ts) below `viralChance`. The
 *   generator state is saved, so reloading cannot re-roll a flex.
 */
import { applyAction, type ActionDef, type ActionError, type ActionResult } from './actions'
import { calendar } from './clock'
import { recordClout, styleScore, type LevelUp } from './clout'
import type { EngineConfig } from './config'
import type { GameSnapshot, PlayerState } from './game'
import { placeAllows, type Place } from './places'
import { createRng, mixSeed } from './rng'

function isVenue(place: Place): place is Extract<Place, { readonly type: string }> {
  return 'type' in place
}

/**
 * How much a flex at a landmark counts: its configured multiplier or the default. Null where
 * a landmark does not allow flexing (memorials included) and for every venue (see
 * `flexPlaceMultiplier` for venues).
 */
export function flexMultiplier(place: Place, config: EngineConfig): number | null {
  if (isVenue(place) || !placeAllows(place, 'flex')) return null
  const { byLandmark } = config.place.flexMultiplier
  return (
    (Object.hasOwn(byLandmark, place.id) ? byLandmark[place.id] : undefined) ??
    config.place.flexMultiplier.default
  )
}

/**
 * The multiplier a flex at `place` gets, or null where the player cannot flex: a landmark's
 * `flexMultiplier`, or the default at a venue of a type in `clout.flex.venueTypes`.
 */
export function flexPlaceMultiplier(place: Place, config: EngineConfig): number | null {
  if (!isVenue(place)) return flexMultiplier(place, config)
  return config.clout.flex.venueTypes.includes(place.type)
    ? config.place.flexMultiplier.default
    : null
}

/** The chance (0..maxChance) a flex goes viral for this style score at this place. */
export function viralChance(score: number, placeMultiplier: number, config: EngineConfig): number {
  const { baseChance, perStylePoint, maxChance } = config.clout.flex.viral
  return Math.min(maxChance, (baseChance + Math.max(0, score) * perStylePoint) * placeMultiplier)
}

/** The Flex action's costs as an action (validated by `applyAction` like any other). */
export function flexAction(config: EngineConfig): ActionDef {
  const { durationMin, energyCost, cashCost } = config.clout.flex
  return { durationMin, cashCost, energyCost, statEffects: {} }
}

/** Why the player cannot flex at a place today, beyond costs. */
export type FlexLimit =
  | { readonly code: 'flexed-here-today' }
  | { readonly code: 'flex-daily-limit'; readonly max: number }

/** The game day of `minute`, and the flexes already made on it. */
function today(player: PlayerState, minute: number, config: EngineConfig) {
  const day = calendar(minute, config).day
  const flexedToday = Object.values(player.flex.byPlace).filter((d) => d === day).length
  return { day, flexedToday }
}

/** Whether the player has used up today's flex here or today's flexes altogether. */
export function flexLimit(
  placeId: string,
  snapshot: GameSnapshot,
  config: EngineConfig,
): FlexLimit | null {
  const { player } = snapshot
  const { day, flexedToday } = today(player, snapshot.clock.minute, config)
  if (Object.hasOwn(player.flex.byPlace, placeId) && player.flex.byPlace[placeId] === day) {
    return { code: 'flexed-here-today' }
  }
  const max = config.clout.flex.maxPerGameDay
  if (flexedToday >= max) return { code: 'flex-daily-limit', max }
  return null
}

/** The clout a flex earns before the place and style multipliers. */
export function flexBase(viral: boolean, config: EngineConfig): number {
  const { baseClout, viral: rules } = config.clout.flex
  return viral ? baseClout * rules.cloutMultiplier : baseClout
}

export type FlexError =
  | { readonly code: 'FLEX_NOT_ALLOWED'; readonly placeId: string }
  | { readonly code: 'FLEX_LIMIT'; readonly limit: FlexLimit }
  | ActionError

export type FlexResult =
  | (Extract<ActionResult, { ok: true }> & {
      readonly viral: boolean
      /** The chance it had of going viral. */
      readonly chance: number
      /** Clout actually gained. */
      readonly cloutGained: number
      readonly levelUp: LevelUp | null
    })
  | { readonly ok: false; readonly error: FlexError }

/**
 * Flexes at `place`: pays the costs, fast-forwards the clock, draws once for viral and
 * records the clout. Refuses a place where flexing is not allowed and a used-up flex. The
 * borough and opening hours are the caller's to check (`performPlaceAction` does).
 */
export function performFlex(
  snapshot: GameSnapshot,
  place: Place,
  config: EngineConfig,
): FlexResult {
  const placeMultiplier = flexPlaceMultiplier(place, config)
  if (placeMultiplier === null) {
    return { ok: false, error: { code: 'FLEX_NOT_ALLOWED', placeId: place.id } }
  }
  const limit = flexLimit(place.id, snapshot, config)
  if (limit !== null) return { ok: false, error: { code: 'FLEX_LIMIT', limit } }

  const started = snapshot.clock.minute
  const score = styleScore(snapshot.player, config)
  const chance = viralChance(score, placeMultiplier, config)
  const result = applyAction(snapshot, flexAction(config), config)
  if (!result.ok) return result

  const rng = createRng(mixSeed(snapshot.player.flex.rngState, started))
  const viral = rng.next() < chance
  const base = flexBase(viral, config)
  const { day } = today(snapshot.player, started, config)
  const done = result.snapshot
  const byPlace = Object.fromEntries(
    Object.entries(done.player.flex.byPlace).filter(([, flexedOn]) => flexedOn === day),
  )
  const flexed: GameSnapshot = {
    ...done,
    player: {
      ...done.player,
      flex: { rngState: rng.state, byPlace: { ...byPlace, [place.id]: day } },
    },
  }
  const record = recordClout(
    flexed,
    {
      source: 'flex',
      amount: base,
      ref: { placeId: place.id, viral, placeMultiplier, styleScore: score, base },
    },
    config,
  )
  return {
    ...result,
    snapshot: { ...flexed, player: record.player },
    viral,
    chance,
    cloutGained: record.entry?.amount ?? 0,
    levelUp: record.levelUp,
  }
}
