/**
 * Events: data-driven moments (data/events) that interrupt play with two or three choices.
 *
 * An event is eligible when every condition it lists holds (personal-clock hours, game day,
 * borough, place, stats, cash, clout, items), it is off cooldown, and no safety rule forbids
 * it. A roll first draws against `events.rollChance`, then picks one eligible event with
 * probability proportional to its `weight`. All randomness comes from a seeded `Rng`
 * (src/engine/rng.ts); the save keeps the generator state, so a reload cannot re-roll.
 *
 * Safety rules (CLAUDE.md) hold here whatever the data says, on top of the schema checks:
 * - nothing fires at a memorial (look-only stops);
 * - no crime event fires at a government building;
 * - a place is judged by its category in the place data, not the caller's word, and nothing
 *   fires at a place id the data does not know.
 *
 * Choice effects: cash, stats, time and clout apply now (cash first, then the clock
 * fast-forwards with passive decay, then stat changes land, as for actions, then clout is
 * recorded in the clout ledger as one `event` entry, scaled by the outfit's style when it is a
 * gain). Item effects have no system to land in yet, so they are kept as typed pending effects
 * in the save, each with its source, for that system to consume.
 */
import { calendar, type Rollovers } from './clock'
import { engineConfig, type EngineConfig } from './config'
import { recordClout, totalClout, type LevelUp } from './clout'
import { advanceMinutes, type GameSnapshot } from './game'
import type { RentEvent } from './rent'
import { createRng, mixSeed, type Rng } from './rng'
import { STAT_KEYS, applyStatChanges, type StatKey } from './stats'
import type {
  EventChoice,
  EventConditions,
  EventEffect,
  GameEvent,
  Landmark,
  LocationCategory,
} from '@/lib/data/schemas/content'

export type Borough = Landmark['borough']

/** Where the player is and what they have, beyond the snapshot. Built by the caller. */
export interface EventContext {
  /** Null when the borough is unknown (for example while travelling). */
  readonly borough: Borough | null
  /** Landmark or venue id the player is at, or null on the street. */
  readonly locationId: string | null
  /**
   * The kind of place when there is no `locationId`. With a `locationId`, the engine takes the
   * category from place data (`EngineConfig.places`) and ignores this value.
   */
  readonly locationCategory: LocationCategory | null
  /** Ids of items the player owns. S10 supplies them; empty until then. */
  readonly itemIds: readonly string[]
}

/** Where a pending effect came from, so the system that consumes it can record its source. */
export interface EventEffectSource {
  readonly type: 'event'
  readonly eventId: string
  readonly choiceId: string
}

/** An item effect waiting for the system that grants or consumes it (S10a). */
export interface PendingEffect {
  readonly kind: 'item'
  readonly itemId: string
  readonly op: 'grant' | 'consume'
  readonly source: EventEffectSource
}

export interface EventsState {
  /** The open event's id, or null. Only one event is open at a time. */
  readonly active: string | null
  /** Personal-clock minute each event last fired, by event id. */
  readonly history: Readonly<Record<string, number>>
  /** Oldest first, at most `events.maxPendingEffects` (the oldest drop first). */
  readonly pending: readonly PendingEffect[]
  /** uint32 state of the event random generator. */
  readonly rngState: number
}

export type EventError =
  | { readonly code: 'UNKNOWN_EVENT'; readonly eventId: string }
  | { readonly code: 'EVENT_ALREADY_ACTIVE'; readonly activeId: string }
  | { readonly code: 'EVENT_NOT_ELIGIBLE'; readonly eventId: string }
  | { readonly code: 'NO_ACTIVE_EVENT' }
  | { readonly code: 'UNKNOWN_CHOICE'; readonly eventId: string; readonly choiceId: string }
  | { readonly code: 'INSUFFICIENT_FUNDS'; readonly required: number; readonly available: number }

export interface EventOutcome {
  readonly eventId: string
  readonly choiceId: string
  /** Copy key of what happened. */
  readonly resultKey: string
  /** The chosen option's effects, as defined (for the result screen). */
  readonly effects: readonly EventEffect[]
  /** Game minutes the clock moved. */
  readonly durationMin: number
  readonly rollovers: Rollovers
  /**
   * Clout actually applied (style-scaled when a gain, clamped when a loss would take earned
   * clout below 0); 0 when the choice has no clout effect.
   */
  readonly cloutApplied: number
}

export type ChooseResult =
  | {
      readonly ok: true
      readonly snapshot: GameSnapshot
      readonly events: EventsState
      readonly outcome: EventOutcome
      /** Rent charged, missed or collected while the choice's time passed, in order. */
      readonly rent: readonly RentEvent[]
      /** Set when the choice's clout lifted the player to a new level. */
      readonly levelUp: LevelUp | null
    }
  | { readonly ok: false; readonly error: EventError }

export type OpenResult =
  | { readonly ok: true; readonly events: EventsState; readonly event: GameEvent }
  | { readonly ok: false; readonly error: EventError }

export interface RollResult {
  readonly events: EventsState
  /** The event that fired and is now open, or null. */
  readonly event: GameEvent | null
}

export function initialEventsState(): EventsState {
  return { active: null, history: {}, pending: [], rngState: 0 }
}

export function findEvent(eventId: string, config: EngineConfig): GameEvent | undefined {
  return config.events.catalog.find((event) => event.id === eventId)
}

/** Net whole dollars a choice takes from the player (0 when it costs nothing). */
export function choiceCashCost(choice: Pick<EventChoice, 'effects'>): number {
  const net = choice.effects.reduce(
    (sum, effect) => (effect.kind === 'cash' ? sum + effect.amount : sum),
    0,
  )
  return Math.max(0, -net)
}

/** True when a player holding `cash` whole dollars can afford a choice. */
export function canAffordChoice(choice: EventChoice, cash: number): boolean {
  return cash >= choiceCashCost(choice)
}

/**
 * Where the player is, by the data rather than the caller: a known `locationId` takes its
 * category from `config.places`, whatever category the caller passed. An id the data does not
 * know is `unknown`, never "the street", so a missing or stale place cannot slip past the
 * memorial and government rules. Without an id, the caller's category stands.
 */
export function resolvePlace(
  context: EventContext,
  config: EngineConfig,
):
  { readonly known: true; readonly category: LocationCategory | null } | { readonly known: false } {
  if (context.locationId === null) return { known: true, category: context.locationCategory }
  const category = config.places.get(context.locationId)
  return category === undefined ? { known: false } : { known: true, category }
}

/**
 * The safety rules, independent of any condition in the data: nothing at a memorial, no crime
 * event at a government building, and nothing at a place the data does not know.
 */
export function isForbiddenAt(
  event: GameEvent,
  context: EventContext,
  config: EngineConfig = engineConfig,
): boolean {
  const place = resolvePlace(context, config)
  if (!place.known || place.category === 'memorial') return true
  return event.tags.includes('crime') && place.category === 'government'
}

interface Range {
  readonly min?: number | undefined
  readonly max?: number | undefined
}

function inRange(value: number, range: Range | undefined): boolean {
  if (range === undefined) return true
  return (
    (range.min === undefined || value >= range.min) &&
    (range.max === undefined || value <= range.max)
  )
}

/** True when every condition listed holds for this player, moment and place. */
export function conditionsHold(
  conditions: EventConditions,
  snapshot: GameSnapshot,
  context: EventContext,
  config: EngineConfig,
): boolean {
  const { hours, minDay, boroughs, locationIds, locationCategories, stats, cash, clout, items } =
    conditions
  const now = calendar(snapshot.clock.minute, config)

  if (hours !== undefined) {
    const inside =
      hours.from < hours.to
        ? now.hour >= hours.from && now.hour < hours.to
        : now.hour >= hours.from || now.hour < hours.to
    if (!inside) return false
  }
  if (minDay !== undefined && now.day < minDay) return false
  if (boroughs !== undefined && (context.borough === null || !boroughs.includes(context.borough))) {
    return false
  }
  if (locationIds !== undefined || locationCategories !== undefined) {
    const { locationId, locationCategory } = context
    const atId = locationId !== null && (locationIds ?? []).includes(locationId)
    const categories: readonly string[] = locationCategories ?? []
    const atCategory = locationCategory !== null && categories.includes(locationCategory)
    if (!atId && !atCategory) return false
  }
  if (stats !== undefined) {
    const { stats: current } = snapshot.player
    if (!STAT_KEYS.every((key) => inRange(current[key], stats[key]))) return false
  }
  if (!inRange(snapshot.player.cash, cash)) return false
  if (clout !== undefined && !inRange(totalClout(snapshot.player, config), clout)) return false
  if (items !== undefined) {
    const owns = (id: string) => context.itemIds.includes(id)
    if (items.anyOf !== undefined && !items.anyOf.some(owns)) return false
    if (items.noneOf !== undefined && items.noneOf.some(owns)) return false
  }
  return true
}

/** False while the event's cooldown runs, and forever after a `once` event has fired. */
export function isOffCooldown(
  event: GameEvent,
  events: EventsState,
  minute: number,
  config: EngineConfig,
): boolean {
  if (!Object.hasOwn(events.history, event.id)) return true
  if (event.once === true) return false
  const last = events.history[event.id] ?? 0
  return minute - last >= (event.cooldownMin ?? config.events.defaultCooldownMin)
}

export function isEventEligible(
  event: GameEvent,
  snapshot: GameSnapshot,
  events: EventsState,
  context: EventContext,
  config: EngineConfig,
): boolean {
  const place = resolvePlace(context, config)
  if (!place.known) return false
  const resolved = { ...context, locationCategory: place.category }
  return (
    !isForbiddenAt(event, resolved, config) &&
    isOffCooldown(event, events, snapshot.clock.minute, config) &&
    conditionsHold(event.conditions, snapshot, resolved, config)
  )
}

export function eligibleEvents(
  snapshot: GameSnapshot,
  events: EventsState,
  context: EventContext,
  config: EngineConfig,
): GameEvent[] {
  return config.events.catalog.filter((event) =>
    isEventEligible(event, snapshot, events, context, config),
  )
}

/** Picks one event with probability weight / total weight. Null for an empty list. */
export function pickWeighted(candidates: readonly GameEvent[], rng: Rng): GameEvent | null {
  const total = candidates.reduce((sum, event) => sum + event.weight, 0)
  if (total <= 0) return null
  let remaining = rng.next() * total
  for (const event of candidates) {
    remaining -= event.weight
    if (remaining < 0) return event
  }
  return candidates[candidates.length - 1] ?? null
}

/**
 * Pure selection: whether an event fires now, and which. Draws once for the chance and, when
 * it passes, once for the pick. Nothing fires while an event is open.
 */
export function selectEvent(
  snapshot: GameSnapshot,
  events: EventsState,
  context: EventContext,
  config: EngineConfig,
  rng: Rng,
): GameEvent | null {
  if (events.active !== null) return null
  if (rng.next() >= config.events.rollChance) return null
  return pickWeighted(eligibleEvents(snapshot, events, context, config), rng)
}

function fire(events: EventsState, event: GameEvent, minute: number): EventsState {
  return { ...events, active: event.id, history: { ...events.history, [event.id]: minute } }
}

/**
 * Rolls for an event with the saved generator. The seed mixes in the clock minute, so rolls at
 * different moments differ even for saves that start from the same state.
 */
export function rollEvent(
  snapshot: GameSnapshot,
  events: EventsState,
  context: EventContext,
  config: EngineConfig,
): RollResult {
  if (events.active !== null) return { events, event: null }
  const rng = createRng(mixSeed(events.rngState, snapshot.clock.minute))
  const event = selectEvent(snapshot, events, context, config, rng)
  const next = { ...events, rngState: rng.state }
  return event === null
    ? { events: next, event: null }
    : { events: fire(next, event, snapshot.clock.minute), event }
}

/**
 * Opens a specific event (scripted triggers, the e2e hook). It must be eligible here and now,
 * so the safety rules and conditions hold for every way an event can open.
 */
export function openEvent(
  snapshot: GameSnapshot,
  events: EventsState,
  eventId: string,
  context: EventContext,
  config: EngineConfig,
): OpenResult {
  if (events.active !== null) {
    return { ok: false, error: { code: 'EVENT_ALREADY_ACTIVE', activeId: events.active } }
  }
  const event = findEvent(eventId, config)
  if (event === undefined) return { ok: false, error: { code: 'UNKNOWN_EVENT', eventId } }
  if (!isEventEligible(event, snapshot, events, context, config)) {
    return { ok: false, error: { code: 'EVENT_NOT_ELIGIBLE', eventId } }
  }
  return { ok: true, events: fire(events, event, snapshot.clock.minute), event }
}

/** Resolves the open event with one of its choices and closes it. Nothing changes on failure. */
export function chooseEventOption(
  snapshot: GameSnapshot,
  events: EventsState,
  choiceId: string,
  config: EngineConfig,
): ChooseResult {
  if (events.active === null) return { ok: false, error: { code: 'NO_ACTIVE_EVENT' } }
  const event = findEvent(events.active, config)
  if (event === undefined) {
    return { ok: false, error: { code: 'UNKNOWN_EVENT', eventId: events.active } }
  }
  const choice = event.choices.find((entry) => entry.id === choiceId)
  if (choice === undefined) {
    return { ok: false, error: { code: 'UNKNOWN_CHOICE', eventId: event.id, choiceId } }
  }
  const required = choiceCashCost(choice)
  if (snapshot.player.cash < required) {
    return {
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required, available: snapshot.player.cash },
    }
  }

  let cashDelta = 0
  let cloutDelta = 0
  let minutes = 0
  const statChanges: Record<StatKey, number> = { energy: 0, hunger: 0, mood: 0 }
  const pending: PendingEffect[] = []
  const source: EventEffectSource = { type: 'event', eventId: event.id, choiceId }
  for (const effect of choice.effects) {
    switch (effect.kind) {
      case 'cash':
        cashDelta += effect.amount
        break
      case 'stat':
        statChanges[effect.stat] += effect.amount
        break
      case 'time':
        minutes += effect.minutes
        break
      case 'clout':
        cloutDelta += effect.amount
        break
      case 'item':
        pending.push({ kind: 'item', itemId: effect.itemId, op: effect.op, source })
        break
    }
  }

  const paid: GameSnapshot = {
    ...snapshot,
    player: { ...snapshot.player, cash: snapshot.player.cash + cashDelta },
  }
  const advanced = advanceMinutes(paid, minutes, config)
  const finished: GameSnapshot = {
    ...advanced.snapshot,
    player: {
      ...advanced.snapshot.player,
      stats: applyStatChanges(advanced.snapshot.player.stats, statChanges, config),
    },
  }
  const record = recordClout(
    finished,
    { source: 'event', amount: cloutDelta, ref: { eventId: event.id, choiceId } },
    config,
  )
  return {
    ok: true,
    snapshot: { ...finished, player: record.player },
    levelUp: record.levelUp,
    events: {
      ...events,
      active: null,
      pending: [...events.pending, ...pending].slice(-config.events.maxPendingEffects),
    },
    outcome: {
      eventId: event.id,
      choiceId,
      resultKey: choice.resultKey,
      effects: choice.effects,
      durationMin: advanced.minutes,
      rollovers: advanced.rollovers,
      cloutApplied: record.entry?.amount ?? 0,
    },
    rent: advanced.rent,
  }
}
