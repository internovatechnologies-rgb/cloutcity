/**
 * What a player can do at a place (S09): the one list the location action sheet shows,
 * whether it was opened from a 3D pin or the Places panel.
 *
 * - Venues offer the actions configured for their type (balance.json `place.venueActions`),
 *   a shift for each of their `jobIds`, and, for clubs, a night inside (`place.clubs`).
 * - Landmarks that allow `visit` offer a Visit (`place.visit`). Memorials offer nothing: they
 *   are look-only (`placeAllows` refuses every hook), so the sheet shows an info card only.
 * - Landmarks that allow `flex`, and venues of a type in `clout.flex.venueTypes`, offer a Flex
 *   (src/engine/flex.ts).
 *
 * Every action is listed even when it cannot be done right now, with a typed reason, so the UI
 * can say why (and put it in the accessible name). A club pays out clout at most once per
 * game night (`clubNightKey`); later entries the same night still cost the cover and time.
 * Reasons are checked in this order: the borough is locked, the place is closed on the
 * personal clock, the club door refuses, the job is locked, today's flexes are used up, the
 * player is somewhere else (DEC-22: they travel there first, src/engine/transit/trip.ts), then
 * funds and energy. `performPlaceAction` re-checks all of them, so a stale UI cannot run
 * something the rules refuse; the shop (`shopBlock`, `buyAtShop`) needs the player there too. Every clout gate reads the player's level clout
 * (src/engine/clout.ts `levelClout`: the total, item clout included, with Icon earned only).
 */
import type { Hours, Venue } from '@/lib/data/schemas/content'
import { applyAction, findAction, type ActionDef, type ActionError } from './actions'
import { boroughAccess, type BoroughAccess } from './boroughs'
import { calendar, type Rollovers } from './clock'
import {
  findCloutLevel,
  playerLevel,
  recordClout,
  scaledGain,
  styleScore,
  levelClout,
  type LevelUp,
} from './clout'
import type { EngineConfig, JobId } from './config'
import {
  flexAction,
  flexBase,
  flexLimit,
  flexPlaceMultiplier,
  performFlex,
  viralChance,
} from './flex'
import { isAtPlace, type GameSnapshot } from './game'
import { buyItem, type ItemResult } from './items'
import { isJobId, jobLock, shiftAction, shiftWage, workShift, type JobLock } from './jobs'
import { isOpenAt, minuteOf, placeAllows, type Place } from './places'
import type { RentEvent } from './rent'
import type { StatChanges } from './stats'

/** Why an action cannot be done right now. */
export type PlaceActionBlock =
  | {
      readonly code: 'borough-locked'
      readonly access: Exclude<BoroughAccess, { readonly status: 'open' }>
    }
  /** Closed on the personal clock; `opensAt` is the opening time (`HH:MM`). */
  | { readonly code: 'closed'; readonly opensAt: string }
  /** The club door: below `requiredLevel`. `refusalKey` is the in-voice copy key. */
  | {
      readonly code: 'door'
      readonly requiredLevel: string
      readonly currentLevel: string
      readonly refusalKey: string
    }
  | { readonly code: 'job-locked'; readonly lock: JobLock }
  /** Already flexed at this place today. */
  | { readonly code: 'flexed-here-today' }
  /** Already flexed `max` times today. */
  | { readonly code: 'flex-daily-limit'; readonly max: number }
  /** The player is somewhere else: they travel here first (DEC-22). */
  | { readonly code: 'away' }
  | { readonly code: 'funds'; readonly required: number; readonly available: number }
  | { readonly code: 'energy'; readonly required: number; readonly available: number }

interface PlaceActionBase {
  /** Unique within a place: an action id, `shift-<jobId>`, `club-night`, `visit` or `flex`. */
  readonly id: string
  /** Up-front costs, base duration and the stat effects when it ends. */
  readonly def: ActionDef
  /** Null when the player can do it now. */
  readonly block: PlaceActionBlock | null
}

export type PlaceAction =
  /** A catalog or place action (a meal, a coffee, a workout). */
  | (PlaceActionBase & { readonly kind: 'consume' })
  | (PlaceActionBase & { readonly kind: 'shift'; readonly jobId: JobId; readonly wage: number })
  /**
   * A night inside a club: the cover is `def.cashCost`; clout lands when the night ends, at
   * most once per club per game night.
   */
  | (PlaceActionBase & {
      readonly kind: 'club-night'
      readonly coverCharge: number
      /**
       * Clout this entry earns: exactly the club's configured gain (style never multiplies
       * nightlife clout), or 0 once it has paid out tonight.
       */
      readonly cloutGain: number
      /** True when this club already paid out clout tonight. */
      readonly cloutEarnedTonight: boolean
      /** The night an entry now belongs to (`clubNightKey`). */
      readonly nightKey: number
    })
  | (PlaceActionBase & { readonly kind: 'visit' })
  /** Post a fit here for clout (src/engine/flex.ts). */
  | (PlaceActionBase & {
      readonly kind: 'flex'
      readonly placeMultiplier: number
      /** Clout a flex earns now if it does not go viral (place and style applied). */
      readonly cloutGain: number
      /** Clout it earns if it goes viral. */
      readonly viralCloutGain: number
      /** The chance (0..1) it goes viral. */
      readonly viralChance: number
    })

/** Opening hours on the personal clock right now. Times are `HH:MM`. */
export type PlaceHoursNow =
  | { readonly status: 'always' }
  | { readonly status: 'open'; readonly closesAt: string }
  | { readonly status: 'closed'; readonly opensAt: string }

export type PlaceView =
  /** A memorial: an info card only, no actions of any kind. */
  | { readonly kind: 'look-only' }
  | {
      readonly kind: 'actions'
      readonly access: BoroughAccess
      readonly hours: PlaceHoursNow
      /**
       * A club's door rule, shown before the player travels there: the level it lets in and
       * whether the player holds it now. Null at every other place.
       */
      readonly door: ClubDoor | null
      readonly actions: readonly PlaceAction[]
    }

/** A club door: the lowest clout level it lets in, and whether the player is at it. */
export interface ClubDoor {
  readonly requiredLevel: string
  readonly met: boolean
}

function isVenue(place: Place): place is Venue {
  return 'type' in place
}

/** A place's opening state at the personal clock's time of day. Landmarks never close. */
export function placeHoursNow(
  place: Place,
  snapshot: GameSnapshot,
  config: EngineConfig,
): PlaceHoursNow {
  if (!isVenue(place) || place.hours === '24h') return { status: 'always' }
  const { minuteOfDay } = calendar(snapshot.clock.minute, config)
  return isOpenAt(place.hours, minuteOfDay)
    ? { status: 'open', closesAt: place.hours.close }
    : { status: 'closed', opensAt: place.hours.open }
}

/**
 * Which game night `minute` belongs to at a club with `hours`: the game day the opening window
 * started on. For a club open 22:00 to 04:00, 22:00 on day 5 and 00:30 on day 6 are both night
 * 5. Day 1 before a past-midnight close is night 0 (the night "before" the game started).
 */
export function clubNightKey(hours: Hours, minute: number, config: EngineConfig): number {
  const { day, minuteOfDay } = calendar(minute, config)
  if (hours === '24h') return day
  const open = minuteOf(hours.open)
  const close = minuteOf(hours.close)
  return open > close && minuteOfDay < close ? day - 1 : day
}

/** The configured action with `id`, from `actions.catalog` or `place.actions`. */
function placeActionDef(id: string, config: EngineConfig): ActionDef {
  const def =
    findAction(id, config) ??
    (Object.hasOwn(config.place.actions, id) ? config.place.actions[id] : undefined)
  if (def === undefined) throw new Error(`place.venueActions names an unknown action "${id}"`)
  return def
}

function clubRule(venueId: string, config: EngineConfig) {
  if (!Object.hasOwn(config.place.clubs, venueId)) {
    throw new Error(`place.clubs has no rule for the club "${venueId}"`)
  }
  const rule = config.place.clubs[venueId]
  if (rule === undefined) throw new Error(`place.clubs has no rule for the club "${venueId}"`)
  return rule
}

/** The club door: why it refuses this player, or null when it lets them in. */
function doorBlock(
  venueId: string,
  snapshot: GameSnapshot,
  config: EngineConfig,
): PlaceActionBlock | null {
  const rule = clubRule(venueId, config)
  const required = findCloutLevel(rule.minCloutLevel, config)
  if (required === undefined) {
    throw new Error(`place.clubs.${venueId}: unknown clout level "${rule.minCloutLevel}"`)
  }
  const current = playerLevel(snapshot.player, config)
  if (current.index >= required.index) return null
  return {
    code: 'door',
    requiredLevel: required.id,
    currentLevel: current.id,
    refusalKey: rule.refusalKey,
  }
}

/** The door rule of the club at `place`, or null when it is not a club. */
function clubDoor(place: Place, snapshot: GameSnapshot, config: EngineConfig): ClubDoor | null {
  if (!isVenue(place) || place.type !== 'club') return null
  const block = doorBlock(place.id, snapshot, config)
  return block?.code === 'door'
    ? { requiredLevel: block.requiredLevel, met: false }
    : { requiredLevel: clubRule(place.id, config).minCloutLevel, met: true }
}

type Unblocked<T> = T extends PlaceAction ? Omit<T, 'block'> : never

function venueActions(
  venue: Venue,
  snapshot: GameSnapshot,
  config: EngineConfig,
): Unblocked<PlaceAction>[] {
  const configured = Object.hasOwn(config.place.venueActions, venue.type)
    ? (config.place.venueActions[venue.type] ?? [])
    : []
  const list: Unblocked<PlaceAction>[] = configured.map((id) => ({
    kind: 'consume',
    id,
    def: placeActionDef(id, config),
  }))
  if (venue.type !== 'subway-station') {
    for (const jobId of venue.jobIds ?? []) {
      if (!isJobId(jobId, config)) continue
      list.push({
        kind: 'shift',
        id: `shift-${jobId}`,
        jobId,
        wage: shiftWage(jobId, config),
        def: shiftAction(jobId, config),
      })
    }
  }
  if (venue.type === 'club') {
    const rule = clubRule(venue.id, config)
    const nightKey = clubNightKey(venue.hours, snapshot.clock.minute, config)
    const { clubNights } = snapshot.player
    const cloutEarnedTonight =
      Object.hasOwn(clubNights, venue.id) && clubNights[venue.id] === nightKey
    list.push({
      kind: 'club-night',
      id: 'club-night',
      coverCharge: rule.coverCharge,
      cloutGain: cloutEarnedTonight ? 0 : rule.cloutGain,
      cloutEarnedTonight,
      nightKey,
      def: {
        durationMin: rule.durationMin,
        cashCost: rule.coverCharge,
        energyCost: rule.energyCost,
        statEffects: { mood: rule.moodGain },
      },
    })
  }
  const flex = flexOffer(venue, snapshot, config)
  if (flex !== null) list.push(flex)
  return list
}

/** The Flex action at `place`, or null where the player cannot flex. */
function flexOffer(
  place: Place,
  snapshot: GameSnapshot,
  config: EngineConfig,
): Unblocked<PlaceAction> | null {
  const placeMultiplier = flexPlaceMultiplier(place, config)
  if (placeMultiplier === null) return null
  const { player } = snapshot
  const gain = (viral: boolean) =>
    scaledGain(flexBase(viral, config), 'flex', placeMultiplier, player, config)
  return {
    kind: 'flex',
    id: 'flex',
    def: flexAction(config),
    placeMultiplier,
    cloutGain: gain(false),
    viralCloutGain: gain(true),
    viralChance: viralChance(styleScore(player, config), placeMultiplier, config),
  }
}

/** A landmark's actions: Visit and Flex where it allows them (a memorial allows neither). */
function landmarkActions(
  place: Place,
  snapshot: GameSnapshot,
  config: EngineConfig,
): Unblocked<PlaceAction>[] {
  const list: Unblocked<PlaceAction>[] = placeAllows(place, 'visit') ? [visitAction(config)] : []
  const flex = flexOffer(place, snapshot, config)
  if (flex !== null) list.push(flex)
  return list
}

function visitAction(config: EngineConfig): Unblocked<PlaceAction> {
  const { durationMin, energyCost, moodGain } = config.place.visit
  return {
    kind: 'visit',
    id: 'visit',
    def: { durationMin, cashCost: 0, energyCost, statEffects: { mood: moodGain } },
  }
}

function blockFor(
  action: Unblocked<PlaceAction>,
  place: Place,
  access: BoroughAccess,
  hours: PlaceHoursNow,
  snapshot: GameSnapshot,
  config: EngineConfig,
): PlaceActionBlock | null {
  if (access.status !== 'open') return { code: 'borough-locked', access }
  if (hours.status === 'closed') return { code: 'closed', opensAt: hours.opensAt }
  if (action.kind === 'club-night') {
    const door = doorBlock(place.id, snapshot, config)
    if (door !== null) return door
  }
  if (action.kind === 'shift') {
    const lock = jobLock(snapshot.player, action.jobId, config)
    if (lock !== null) return { code: 'job-locked', lock }
  }
  if (action.kind === 'flex') {
    const limit = flexLimit(place.id, snapshot, config)
    if (limit !== null) return limit
  }
  if (!isAtPlace(snapshot.player, place.id)) return { code: 'away' }
  const { cash, stats } = snapshot.player
  if (cash < action.def.cashCost) {
    return { code: 'funds', required: action.def.cashCost, available: cash }
  }
  if (stats.energy < action.def.energyCost) {
    return { code: 'energy', required: action.def.energyCost, available: stats.energy }
  }
  return null
}

/** Everything the player can see and do at `place` right now. */
export function placeActions(
  place: Place,
  snapshot: GameSnapshot,
  config: EngineConfig,
): PlaceView {
  if (!isVenue(place) && place.category === 'memorial') return { kind: 'look-only' }
  const access = boroughAccess(place.borough, levelClout(snapshot.player, config), config)
  const hours = placeHoursNow(place, snapshot, config)
  const unblocked = isVenue(place)
    ? venueActions(place, snapshot, config)
    : landmarkActions(place, snapshot, config)
  const actions = unblocked.map(
    (action) =>
      ({
        ...action,
        block: blockFor(action, place, access, hours, snapshot, config),
      }) as PlaceAction,
  )
  return { kind: 'actions', access, hours, door: clubDoor(place, snapshot, config), actions }
}

export { flexMultiplier } from './flex'

export type PlaceActionError =
  | { readonly code: 'LOOK_ONLY' }
  | { readonly code: 'UNKNOWN_PLACE_ACTION'; readonly actionId: string }
  | { readonly code: 'BLOCKED'; readonly block: PlaceActionBlock }
  | { readonly code: 'ACTION_FAILED'; readonly cause: ActionError }

export type PlaceActionResult =
  | {
      readonly ok: true
      readonly snapshot: GameSnapshot
      readonly action: PlaceAction
      /** Game minutes the clock moved (after any slowdown). */
      readonly durationMin: number
      readonly rollovers: Rollovers
      readonly rent: readonly RentEvent[]
      /** Whole dollars a shift paid (0 otherwise). */
      readonly wage: number
      /** Clout the action earned (0 otherwise). */
      readonly cloutGained: number
      /** How a flex went (null for every other action). */
      readonly flex: { readonly viral: boolean; readonly chance: number } | null
      /** Set when the clout gained lifted the player to a new level. */
      readonly levelUp: LevelUp | null
      /** The stat effects applied when the action ended. */
      readonly statEffects: StatChanges
    }
  | { readonly ok: false; readonly error: PlaceActionError }

/** Does `actionId` at `place`, after re-checking every rule `placeActions` reports. */
export function performPlaceAction(
  snapshot: GameSnapshot,
  place: Place,
  actionId: string,
  config: EngineConfig,
): PlaceActionResult {
  const view = placeActions(place, snapshot, config)
  if (view.kind === 'look-only') return { ok: false, error: { code: 'LOOK_ONLY' } }
  const action = view.actions.find((candidate) => candidate.id === actionId)
  if (action === undefined) return { ok: false, error: { code: 'UNKNOWN_PLACE_ACTION', actionId } }
  if (action.block !== null) return { ok: false, error: { code: 'BLOCKED', block: action.block } }

  if (action.kind === 'shift') {
    const result = workShift(snapshot, action.jobId, config)
    if (!result.ok) {
      // jobLock is checked above, so only an action error can remain.
      const { error } = result
      if (error.code === 'UNKNOWN_JOB' || error.code === 'JOB_LOCKED') {
        throw new Error(`workShift refused a shift placeActions allowed: ${error.code}`)
      }
      return { ok: false, error: { code: 'ACTION_FAILED', cause: error } }
    }
    const { snapshot: next, durationMin, rollovers, rent, wage, cloutGained, levelUp } = result
    return {
      ok: true,
      snapshot: next,
      action,
      durationMin,
      rollovers,
      rent,
      wage,
      cloutGained,
      flex: null,
      levelUp,
      statEffects: action.def.statEffects,
    }
  }

  if (action.kind === 'flex') {
    const result = performFlex(snapshot, place, config)
    if (!result.ok) {
      // placeActions offered the flex and checked its limits, so only an action error remains.
      const { error } = result
      if (error.code === 'FLEX_NOT_ALLOWED' || error.code === 'FLEX_LIMIT') {
        throw new Error(`performFlex refused a flex placeActions allowed: ${error.code}`)
      }
      return { ok: false, error: { code: 'ACTION_FAILED', cause: error } }
    }
    return {
      ok: true,
      snapshot: result.snapshot,
      action,
      durationMin: result.durationMin,
      rollovers: result.rollovers,
      rent: result.rent,
      wage: 0,
      cloutGained: result.cloutGained,
      flex: { viral: result.viral, chance: result.chance },
      levelUp: result.levelUp,
      statEffects: action.def.statEffects,
    }
  }

  const result = applyAction(snapshot, action.def, config)
  if (!result.ok) return { ok: false, error: { code: 'ACTION_FAILED', cause: result.error } }
  if (action.kind !== 'club-night' || action.cloutEarnedTonight) {
    return {
      ok: true,
      snapshot: action.kind === 'visit' ? withVisit(result.snapshot, place.id) : result.snapshot,
      action,
      durationMin: result.durationMin,
      rollovers: result.rollovers,
      rent: result.rent,
      wage: 0,
      cloutGained: 0,
      flex: null,
      levelUp: null,
      statEffects: result.applied,
    }
  }
  const { player } = result.snapshot
  const entered: GameSnapshot = {
    ...result.snapshot,
    player: { ...player, clubNights: { ...player.clubNights, [place.id]: action.nightKey } },
  }
  const record = recordClout(
    entered,
    {
      source: 'club',
      amount: clubRule(place.id, config).cloutGain,
      ref: { venueId: place.id, night: action.nightKey },
    },
    config,
  )
  return {
    ok: true,
    snapshot: { ...entered, player: record.player },
    action,
    durationMin: result.durationMin,
    rollovers: result.rollovers,
    rent: result.rent,
    wage: 0,
    cloutGained: record.entry?.amount ?? 0,
    flex: null,
    levelUp: record.levelUp,
    statEffects: result.applied,
  }
}

/**
 * What the player can do at home (B1): sleep, a nap and a home-cooked meal (`place.homeActions`,
 * in that order), each with why it cannot be done right now. Only at home (DEC-22): away, every
 * one is blocked `away` and the home card offers the trip back. Then funds and energy, as at a
 * place. Home has no hours and no borough gate: wherever the player lives is open to them.
 */
export function homeActions(snapshot: GameSnapshot, config: EngineConfig): readonly PlaceAction[] {
  const { location, cash, stats } = snapshot.player
  return config.place.homeActions.map((id): PlaceAction => {
    const def = placeActionDef(id, config)
    const block: PlaceActionBlock | null =
      location.kind !== 'home'
        ? { code: 'away' }
        : cash < def.cashCost
          ? { code: 'funds', required: def.cashCost, available: cash }
          : stats.energy < def.energyCost
            ? { code: 'energy', required: def.energyCost, available: stats.energy }
            : null
    return { kind: 'consume', id, def, block }
  })
}

/** Does home action `actionId`, after re-checking every rule `homeActions` reports. */
export function performHomeAction(
  snapshot: GameSnapshot,
  actionId: string,
  config: EngineConfig,
): PlaceActionResult {
  const action = homeActions(snapshot, config).find((candidate) => candidate.id === actionId)
  if (action === undefined) return { ok: false, error: { code: 'UNKNOWN_PLACE_ACTION', actionId } }
  if (action.block !== null) return { ok: false, error: { code: 'BLOCKED', block: action.block } }
  const result = applyAction(snapshot, action.def, config)
  if (!result.ok) return { ok: false, error: { code: 'ACTION_FAILED', cause: result.error } }
  return {
    ok: true,
    snapshot: result.snapshot,
    action,
    durationMin: result.durationMin,
    rollovers: result.rollovers,
    rent: result.rent,
    wage: 0,
    cloutGained: 0,
    flex: null,
    levelUp: null,
    statEffects: result.applied,
  }
}

/**
 * Records the first visit to a landmark at the minute the visit ended; later visits keep the
 * first minute (the first-landmark-visit goal, src/engine/goals.ts).
 */
function withVisit(snapshot: GameSnapshot, placeId: string): GameSnapshot {
  const { player } = snapshot
  if (Object.hasOwn(player.visited, placeId)) return snapshot
  return {
    ...snapshot,
    player: { ...player, visited: { ...player.visited, [placeId]: snapshot.clock.minute } },
  }
}

/** Venue types that run a shop (S10a): they sell every item in `shopItems`. */
export const SHOP_VENUE_TYPES = ['boutique', 'thrift'] as const

/** True when `place` is a venue with a shop. */
export function hasShop(place: Place): place is Venue {
  return isVenue(place) && (SHOP_VENUE_TYPES as readonly string[]).includes(place.type)
}

/**
 * Why the shop at `place` cannot sell right now (its borough is locked, it is closed on the
 * personal clock, or the player is somewhere else), or null when it can. Same reasons and order
 * as the place's actions.
 */
export function shopBlock(
  place: Place,
  snapshot: GameSnapshot,
  config: EngineConfig,
): PlaceActionBlock | null {
  const access = boroughAccess(place.borough, levelClout(snapshot.player, config), config)
  if (access.status !== 'open') return { code: 'borough-locked', access }
  const hours = placeHoursNow(place, snapshot, config)
  if (hours.status === 'closed') return { code: 'closed', opensAt: hours.opensAt }
  if (!isAtPlace(snapshot.player, place.id)) return { code: 'away' }
  return null
}

export type ShopBuyResult =
  | ItemResult<{ readonly price: number; readonly levelUp: LevelUp | null }>
  | { readonly ok: false; readonly error: { readonly code: 'NOT_A_SHOP' } }
  | {
      readonly ok: false
      readonly error: { readonly code: 'BLOCKED'; readonly block: PlaceActionBlock }
    }

/**
 * Buys one of `itemId` at the shop at `place`: the place must have a shop that is open to the
 * player right now, then `buyItem`'s rules (funds, owned once, gift stack) apply.
 */
export function buyAtShop(
  snapshot: GameSnapshot,
  place: Place,
  itemId: string,
  config: EngineConfig,
): ShopBuyResult {
  if (!hasShop(place)) return { ok: false, error: { code: 'NOT_A_SHOP' } }
  const block = shopBlock(place, snapshot, config)
  if (block !== null) return { ok: false, error: { code: 'BLOCKED', block } }
  return buyItem(snapshot, itemId, config)
}
