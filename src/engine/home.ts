/**
 * The apartment (S16): decor placed in the player's home, the home score it adds up to, and
 * moving home. Pure functions over a GameSnapshot; nothing here moves the clock.
 *
 * Rules:
 * - Each home has decor slots (data/homes/interiors.json), each of one kind: wall, floor or
 *   surface. A decor item fits one kind (`decor.fits`) and is placed in at most one slot; a slot
 *   holds at most one item. Placing an item where another sits sends that one back to storage
 *   (owned, unplaced); placing an item already placed elsewhere moves it.
 * - Home score = the home's `home.baseScore` plus the `homeScore` of every owned decor item
 *   placed there. Home clout is that score capped at `home.maxClout`. Both are computed from the
 *   save, never accumulated, so a place/remove or buy/place/sell loop cannot farm clout, and no
 *   ledger entry is written for them. Decor kept through prestige is a look only: placed, it adds
 *   nothing (DEC-14).
 * - Placing, removing and moving change clout, so each settles the level (`settleLevel`) and
 *   reports a level-up that lifts the player above their peak; choosing a colour variant changes
 *   only looks.
 * - Moving home (`moveHome`) is instant. It is refused, in this order, when the home is the
 *   current one, when its borough is not open at the player's level (src/engine/boroughs.ts),
 *   and when the player cannot afford it (src/engine/housing.ts `canAffordMove`: cash after the
 *   rent reserve must cover the move-in cost). The move-in cost is paid, decor in slots the new
 *   home also has stays placed (slot ids are shared between homes), the rest goes to storage,
 *   and the move is appended to `apartment.moveLog` (newest last, at most `home.moveLogMax`) for
 *   save plausibility (SEC-11).
 */
import { HOME_BOROUGHS } from '@/lib/data/homes'
import type { Borough } from '@/lib/data/schemas/content'
import { boroughAccess, type BoroughAccess } from './boroughs'
import { levelClout, settleLevel, type LevelUp } from './clout'
import { isHomeId, type EngineConfig, type HomeId, type SlotDef } from './config'
import type { GameSnapshot, PlayerState } from './game'
import { canAffordMove, moveInCost, rentReserve } from './housing'
import { findItem, isDecor, type DecorDef, type DecorFit, type Inventory } from './items'

/** Slot id → the decor item placed there. */
export type Placements = Readonly<Record<string, string>>

/** One move, as the save keeps it. */
export interface MoveRecord {
  readonly from: HomeId
  readonly to: HomeId
  /** Personal-clock minute of the move. */
  readonly at: number
  /** Whole dollars paid (the move-in cost). */
  readonly cost: number
}

export interface ApartmentState {
  /** What is placed in the current home's slots. Every entry names owned decor of the slot's kind. */
  readonly placed: Placements
  /** Moves made with `moveHome`, oldest first, at most `home.moveLogMax`. */
  readonly moveLog: readonly MoveRecord[]
}

export const initialApartment: ApartmentState = { placed: {}, moveLog: [] }

/** What the home score reads. */
export type HomePlayer = Pick<PlayerState, 'home' | 'inventory' | 'apartment'>

/** Why a home is locked to the player right now. */
export type HomeLock =
  /** The player already lives there. */
  | { readonly code: 'CURRENT_HOME'; readonly home: HomeId }
  /** Its borough is not open at the player's level (or is expanding soon). */
  | {
      readonly code: 'BOROUGH_LOCKED'
      readonly home: HomeId
      readonly borough: Borough
      readonly access: Exclude<BoroughAccess, { readonly status: 'open' }>
    }
  /** Cash after the rent reserve does not cover the move-in cost. */
  | {
      readonly code: 'FUNDS_SHORT'
      readonly home: HomeId
      /** The rent reserve plus the move-in cost. */
      readonly required: number
      readonly available: number
    }

export type HomeError =
  | { readonly code: 'UNKNOWN_ITEM'; readonly itemId: string }
  | { readonly code: 'NOT_DECOR'; readonly itemId: string }
  | { readonly code: 'NOT_OWNED'; readonly itemId: string }
  /** The current home has no slot with this id. */
  | { readonly code: 'UNKNOWN_SLOT'; readonly slotId: string }
  | {
      readonly code: 'WRONG_SLOT_KIND'
      readonly itemId: string
      readonly slotId: string
      readonly fits: DecorFit
      readonly kind: DecorFit
    }
  | { readonly code: 'UNKNOWN_VARIANT'; readonly itemId: string; readonly variantId: string }
  | { readonly code: 'UNKNOWN_HOME'; readonly home: string }
  | HomeLock

export type HomeResult<Extra = object> =
  | ({ readonly ok: true; readonly snapshot: GameSnapshot } & Extra)
  | { readonly ok: false; readonly error: HomeError }

/** The decor slots of `home`, in data order. */
export function slotsFor(home: HomeId, config: EngineConfig): readonly SlotDef[] {
  return config.home.slots[home]
}

function findSlot(home: HomeId, slotId: string, config: EngineConfig): SlotDef | undefined {
  return slotsFor(home, config).find((slot) => slot.id === slotId)
}

function decorDef(itemId: string, config: EngineConfig): DecorDef | undefined {
  const item = findItem(itemId, config)
  return item !== undefined && isDecor(item) ? item : undefined
}

/** Owned decor ids that still count toward the home score (not kept through prestige). */
function countingDecor(inventory: Inventory): ReadonlySet<string> {
  return new Set(
    inventory.decor.filter((owned) => owned.prestigeKept !== true).map((owned) => owned.itemId),
  )
}

/** The home's base score plus the `homeScore` of every counting decor item placed there. */
export function homeScore(player: HomePlayer, config: EngineConfig): number {
  const counting = countingDecor(player.inventory)
  return Object.values(player.apartment.placed).reduce((score, itemId) => {
    if (!counting.has(itemId)) return score
    return score + (decorDef(itemId, config)?.decor.homeScore ?? 0)
  }, config.home.baseScore[player.home])
}

/** The clout the home adds: its score, capped at `home.maxClout`. */
export function homeClout(player: HomePlayer, config: EngineConfig): number {
  return Math.min(config.home.maxClout, homeScore(player, config))
}

function withApartment(
  snapshot: GameSnapshot,
  apartment: ApartmentState,
  patch: Partial<PlayerState> = {},
): PlayerState {
  return { ...snapshot.player, ...patch, apartment }
}

/** Settles the level after a home change and returns the snapshot with it. */
function settled(snapshot: GameSnapshot, player: PlayerState, config: EngineConfig) {
  const result = settleLevel(player, snapshot.clock.minute, 'home', config)
  return {
    ok: true as const,
    snapshot: { ...snapshot, player: result.player },
    levelUp: result.levelUp,
  }
}

/** `placed` without `itemId` in any slot. */
function withoutItem(placed: Placements, itemId: string): Placements {
  return Object.fromEntries(Object.entries(placed).filter(([, placedId]) => placedId !== itemId))
}

/**
 * Places owned decor in a slot of the current home. Whatever sat in the slot goes back to
 * storage; the item leaves any other slot it was in.
 */
export function placeDecor(
  snapshot: GameSnapshot,
  itemId: string,
  slotId: string,
  config: EngineConfig,
): HomeResult<{ readonly levelUp: LevelUp | null }> {
  const item = findItem(itemId, config)
  if (item === undefined) return { ok: false, error: { code: 'UNKNOWN_ITEM', itemId } }
  if (!isDecor(item)) return { ok: false, error: { code: 'NOT_DECOR', itemId } }
  const { player } = snapshot
  if (!player.inventory.decor.some((owned) => owned.itemId === itemId)) {
    return { ok: false, error: { code: 'NOT_OWNED', itemId } }
  }
  const slot = findSlot(player.home, slotId, config)
  if (slot === undefined) return { ok: false, error: { code: 'UNKNOWN_SLOT', slotId } }
  if (slot.kind !== item.decor.fits) {
    const error = {
      code: 'WRONG_SLOT_KIND',
      itemId,
      slotId,
      fits: item.decor.fits,
      kind: slot.kind,
    }
    return { ok: false, error: error as HomeError }
  }
  const placed = { ...withoutItem(player.apartment.placed, itemId), [slotId]: itemId }
  return settled(snapshot, withApartment(snapshot, { ...player.apartment, placed }), config)
}

/** Takes whatever is in a slot of the current home back to storage (a no-op when it is empty). */
export function removeDecor(
  snapshot: GameSnapshot,
  slotId: string,
  config: EngineConfig,
): HomeResult<{ readonly levelUp: LevelUp | null }> {
  const { player } = snapshot
  if (findSlot(player.home, slotId, config) === undefined) {
    return { ok: false, error: { code: 'UNKNOWN_SLOT', slotId } }
  }
  if (!Object.hasOwn(player.apartment.placed, slotId)) return { ok: true, snapshot, levelUp: null }
  const placed = Object.fromEntries(
    Object.entries(player.apartment.placed).filter(([id]) => id !== slotId),
  )
  return settled(snapshot, withApartment(snapshot, { ...player.apartment, placed }), config)
}

/** Shows owned decor in another of its colour variants (looks only: no clout change). */
export function setDecorVariant(
  snapshot: GameSnapshot,
  itemId: string,
  variantId: string,
  config: EngineConfig,
): HomeResult {
  const item = findItem(itemId, config)
  if (item === undefined) return { ok: false, error: { code: 'UNKNOWN_ITEM', itemId } }
  if (!isDecor(item)) return { ok: false, error: { code: 'NOT_DECOR', itemId } }
  const { inventory } = snapshot.player
  if (!inventory.decor.some((owned) => owned.itemId === itemId)) {
    return { ok: false, error: { code: 'NOT_OWNED', itemId } }
  }
  if (!item.decor.variants.some((variant) => variant.id === variantId)) {
    return { ok: false, error: { code: 'UNKNOWN_VARIANT', itemId, variantId } }
  }
  const decor = inventory.decor.map((owned) =>
    owned.itemId === itemId ? { ...owned, variant: variantId } : owned,
  )
  return {
    ok: true,
    snapshot: { ...snapshot, player: { ...snapshot.player, inventory: { ...inventory, decor } } },
  }
}

/**
 * The placements that carry over into `to`: each item whose slot `to` also has (with a kind the
 * item fits) stays; the rest go back to storage.
 */
export function placementsAfterMove(
  placed: Placements,
  to: HomeId,
  config: EngineConfig,
): Placements {
  return Object.fromEntries(
    Object.entries(placed).filter(([slotId, itemId]) => {
      const slot = findSlot(to, slotId, config)
      return slot !== undefined && decorDef(itemId, config)?.decor.fits === slot.kind
    }),
  )
}

/** Why the player cannot move into `to` right now, or null when they can (see the module comment). */
export function homeLock(player: PlayerState, to: HomeId, config: EngineConfig): HomeLock | null {
  if (to === player.home) return { code: 'CURRENT_HOME', home: to }
  const borough = HOME_BOROUGHS[to]
  const access = boroughAccess(borough, levelClout(player, config), config)
  if (access.status !== 'open') return { code: 'BOROUGH_LOCKED', home: to, borough, access }
  if (!canAffordMove(player, to, config)) {
    return {
      code: 'FUNDS_SHORT',
      home: to,
      required: rentReserve(player, config) + moveInCost(to, config),
      available: player.cash,
    }
  }
  return null
}

/** Moves into `to` at once, paying its move-in cost (see the module comment). */
export function moveHome(
  snapshot: GameSnapshot,
  to: string,
  config: EngineConfig,
): HomeResult<{ readonly cost: number; readonly levelUp: LevelUp | null }> {
  if (!isHomeId(to, config)) return { ok: false, error: { code: 'UNKNOWN_HOME', home: to } }
  const { player } = snapshot
  const lock = homeLock(player, to, config)
  if (lock !== null) return { ok: false, error: lock }
  const cost = moveInCost(to, config)
  const move: MoveRecord = { from: player.home, to, at: snapshot.clock.minute, cost }
  const apartment: ApartmentState = {
    placed: placementsAfterMove(player.apartment.placed, to, config),
    moveLog: [...player.apartment.moveLog, move].slice(-config.home.moveLogMax),
  }
  const moved = withApartment(snapshot, apartment, { cash: player.cash - cost, home: to })
  return { ...settled(snapshot, moved, config), cost }
}
