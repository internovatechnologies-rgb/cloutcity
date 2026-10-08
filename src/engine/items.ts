/**
 * Items, inventory and outfit (S10): buying, selling, wearing and gifting in-game cash items
 * from data/items/items.json. Pure functions over a GameSnapshot; nothing here moves the clock.
 *
 * Rules:
 * - Wearables (clothing, makeup) are owned at most once each (ALREADY_OWNED) and worn in their
 *   slot, one item per slot. Gifts stack up to `items.maxGiftStack` per gift (STACK_FULL).
 * - Buying costs `price` in cash (INSUFFICIENT_FUNDS if short; nothing changes on failure).
 * - Selling pays the resale value (see `resaleValue`): a gift's `sellValue`, or a wearable's
 *   `sellValue` less `depreciationPctPerGameDay` for each whole game day owned, never below
 *   `minResalePct` of it. Resale is always below the price, so a buy/sell loop only loses cash.
 *   Selling a worn item takes it off first.
 * - Stat effects: a wearable's land once per owned copy, the first time it is worn (sell and
 *   rebuy to feel it again, at a loss); a gift's land on the player when used on themselves.
 *   A gift used on an NPC is consumed with no stat change for the player: what the NPC does
 *   with it is the caller's (the event's) outcome.
 * - Gifts target the player or an NPC, never another player: `GiftTarget` has no way to name a
 *   player, and an NPC id must carry the `npc-` prefix, which no player id can match.
 * - Clout: a wearable's `cloutValue` counts while it is owned (src/engine/clout.ts
 *   `itemClout`, computed from the inventory), so a sold item stops counting and a buy/sell
 *   loop earns nothing. Buying and selling a wearable write an `item` audit entry to the clout
 *   ledger; a purchase that lifts the player to a new level reports it (`levelUp`). Wearing
 *   changes the outfit's style score, never clout itself.
 * - Decor (S16) is owned at most once each, depreciates like a wearable, and is worth no item
 *   clout or style: it adds to the home score only while placed (src/engine/home.ts). A new
 *   purchase shows its first colour variant. Selling placed decor takes it out of its slot
 *   first (which can lower clout, so the level is settled); decor kept through prestige is a
 *   look only and the shop refuses it (PRESTIGE_KEPT).
 */
import { recordClout, settleLevel, type LevelUp } from './clout'
import type { EngineConfig } from './config'
import type { GameSnapshot } from './game'
import {
  ITEM_SLOTS,
  isDecor,
  isGift,
  isWearable,
  type DecorDef,
  type DecorFit,
  type DecorVariant,
  type GiftDef,
  type ItemDef,
  type ItemSlot,
  type WearableDef,
} from './itemCatalog'
import { applyStatChanges } from './stats'

export { ITEM_SLOTS, isDecor, isGift, isWearable }
export type { DecorDef, DecorFit, DecorVariant, GiftDef, ItemDef, ItemSlot, WearableDef }

const MINUTES_PER_HOUR = 60

/** A wearable the player owns. */
export interface OwnedWearable {
  readonly itemId: string
  /** Personal-clock minute it was bought; drives resale depreciation. */
  readonly acquiredMinute: number
  /** True once its stat effects have landed (first time worn). */
  readonly worn: boolean
  /**
   * Kept through prestige from a past run (S15, user ruling Q-8): a look only. It adds no item
   * clout or style, sells for nothing (the shop refuses it) and cannot be bought again while
   * owned, so no value carries into the new run (ECON-1).
   */
  readonly prestigeKept?: true
}

/** A decor item the player owns (S16). Where it is placed lives in `player.apartment`. */
export interface OwnedDecor {
  readonly itemId: string
  /** Personal-clock minute it was bought; drives resale depreciation. */
  readonly acquiredMinute: number
  /** The colour variant shown: one of the item's `decor.variants` ids. */
  readonly variant: string
  /** Kept through prestige from a past run: a look only (as `OwnedWearable.prestigeKept`). */
  readonly prestigeKept?: true
}

/** True for an item kept through prestige: a look only (see `OwnedWearable.prestigeKept`). */
export function isPrestigeKept(owned: { readonly prestigeKept?: true }): boolean {
  return owned.prestigeKept === true
}

export interface GiftStack {
  readonly itemId: string
  /** 1..items.maxGiftStack. */
  readonly count: number
}

export type Outfit = Readonly<Partial<Record<ItemSlot, string>>>

export interface Inventory {
  readonly wearables: readonly OwnedWearable[]
  readonly gifts: readonly GiftStack[]
  /** What is worn, by slot. Every entry names an owned wearable for that slot. */
  readonly outfit: Outfit
  /** Owned decor, placed or in storage (S16). */
  readonly decor: readonly OwnedDecor[]
}

export const emptyInventory: Inventory = { wearables: [], gifts: [], outfit: {}, decor: [] }

declare const npcIdBrand: unique symbol
/** An NPC's id: kebab-case with the `npc-` prefix. Only `toNpcId` makes one. */
export type NpcId = string & { readonly [npcIdBrand]: true }

const NPC_ID = /^npc-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `raw` as an NpcId, or null when it is not one (a player id, handle or anything else). */
export function toNpcId(raw: unknown): NpcId | null {
  return typeof raw === 'string' && NPC_ID.test(raw) ? (raw as NpcId) : null
}

/** Who a gift is used on. There is deliberately no variant for another player. */
// 'yourself', not the bare word for it: the engine purity scan bans that identifier.
export type GiftTarget = 'yourself' | { readonly npcId: NpcId }

export type ItemError =
  | { readonly code: 'UNKNOWN_ITEM'; readonly itemId: string }
  | { readonly code: 'NOT_FOR_SALE'; readonly itemId: string }
  | { readonly code: 'INSUFFICIENT_FUNDS'; readonly required: number; readonly available: number }
  | { readonly code: 'ALREADY_OWNED'; readonly itemId: string }
  | { readonly code: 'STACK_FULL'; readonly itemId: string; readonly max: number }
  | { readonly code: 'NOT_OWNED'; readonly itemId: string }
  /** A wearable kept through prestige: a look only, the shop does not buy it back. */
  | { readonly code: 'PRESTIGE_KEPT'; readonly itemId: string }
  | { readonly code: 'NOT_WEARABLE'; readonly itemId: string }
  | {
      readonly code: 'WRONG_SLOT'
      readonly itemId: string
      readonly slot: string
      /** The slot the item does fill. */
      readonly itemSlot: ItemSlot
    }
  | { readonly code: 'UNKNOWN_SLOT'; readonly slot: string }
  | { readonly code: 'NOT_A_GIFT'; readonly itemId: string }
  | { readonly code: 'INVALID_TARGET' }

export type ItemResult<Extra = object> =
  | ({ readonly ok: true; readonly snapshot: GameSnapshot } & Extra)
  | { readonly ok: false; readonly error: ItemError }

export function findItem(itemId: string, config: EngineConfig): ItemDef | undefined {
  return config.items.catalog.find((item) => item.id === itemId)
}

export function isItemSlot(slot: unknown): slot is ItemSlot {
  return typeof slot === 'string' && (ITEM_SLOTS as readonly string[]).includes(slot)
}

/** An item the shop sells. */
export type ShopItemDef = WearableDef | GiftDef | DecorDef

/** Items the shop sells now: wearables, gifts and decor (apartment upgrades arrive later). */
export function shopItems(config: EngineConfig): readonly ShopItemDef[] {
  return config.items.catalog.filter(
    (item): item is ShopItemDef => isWearable(item) || isGift(item) || isDecor(item),
  )
}

/** Whole game days between buying and now (0 on the day of purchase). */
export function daysOwned(acquiredMinute: number, nowMinute: number, config: EngineConfig) {
  const minutesPerDay = config.time.gameDayHours * MINUTES_PER_HOUR
  return Math.max(0, Math.floor((nowMinute - acquiredMinute) / minutesPerDay))
}

/**
 * Whole dollars an owned item sells for now. Integer maths only: percentages are whole, so
 * the floor is exact.
 */
export function resaleValue(
  item: ItemDef,
  acquiredMinute: number,
  nowMinute: number,
  config: EngineConfig,
): number {
  if (!isWearable(item) && !isDecor(item)) return item.sellValue
  const { depreciationPctPerGameDay, minResalePct } = config.items
  const days = daysOwned(acquiredMinute, nowMinute, config)
  const pct = Math.max(minResalePct, 100 - depreciationPctPerGameDay * days)
  return Math.floor((item.sellValue * pct) / 100)
}

function withInventory(snapshot: GameSnapshot, inventory: Inventory, cash = snapshot.player.cash) {
  return { ...snapshot, player: { ...snapshot.player, cash, inventory } }
}

/** Buys one of `itemId` for its price. */
export function buyItem(
  snapshot: GameSnapshot,
  itemId: string,
  config: EngineConfig,
): ItemResult<{ readonly price: number; readonly levelUp: LevelUp | null }> {
  const item = findItem(itemId, config)
  if (item === undefined) return { ok: false, error: { code: 'UNKNOWN_ITEM', itemId } }
  if (!isWearable(item) && !isGift(item) && !isDecor(item)) {
    return { ok: false, error: { code: 'NOT_FOR_SALE', itemId } }
  }
  const { cash, inventory } = snapshot.player
  let next: Inventory
  if (isDecor(item)) {
    if (inventory.decor.some((owned) => owned.itemId === itemId)) {
      return { ok: false, error: { code: 'ALREADY_OWNED', itemId } }
    }
    const variant = item.decor.variants[0]?.id ?? ''
    const owned: OwnedDecor = { itemId, acquiredMinute: snapshot.clock.minute, variant }
    next = { ...inventory, decor: [...inventory.decor, owned] }
  } else if (isWearable(item)) {
    if (inventory.wearables.some((owned) => owned.itemId === itemId)) {
      return { ok: false, error: { code: 'ALREADY_OWNED', itemId } }
    }
    const owned = { itemId, acquiredMinute: snapshot.clock.minute, worn: false }
    next = { ...inventory, wearables: [...inventory.wearables, owned] }
  } else {
    const max = config.items.maxGiftStack
    const count = giftCount(inventory, itemId)
    if (count >= max) return { ok: false, error: { code: 'STACK_FULL', itemId, max } }
    next = { ...inventory, gifts: setGiftCount(inventory.gifts, itemId, count + 1) }
  }
  if (cash < item.price) {
    return {
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: item.price, available: cash },
    }
  }
  const bought = withInventory(snapshot, next, cash - item.price)
  if (!isWearable(item)) return { ok: true, snapshot: bought, price: item.price, levelUp: null }
  const record = auditItem(bought, item, 'buy', config)
  return { ok: true, snapshot: record.snapshot, price: item.price, levelUp: record.levelUp }
}

/**
 * Writes the clout ledger's audit entry for a wearable changing hands (no entry for an item
 * worth no clout) and reports a level-up the new inventory reached.
 */
function auditItem(
  snapshot: GameSnapshot,
  item: WearableDef,
  op: 'buy' | 'sell',
  config: EngineConfig,
): { readonly snapshot: GameSnapshot; readonly levelUp: LevelUp | null } {
  const amount = op === 'buy' ? item.cloutValue : -item.cloutValue
  const record = recordClout(
    snapshot,
    { source: 'item', amount, ref: { itemId: item.id, op } },
    config,
  )
  return { snapshot: { ...snapshot, player: record.player }, levelUp: record.levelUp }
}

function setGiftCount(gifts: readonly GiftStack[], itemId: string, count: number) {
  const rest = gifts.filter((stack) => stack.itemId !== itemId)
  if (count <= 0) return rest
  const index = gifts.findIndex((stack) => stack.itemId === itemId)
  const stack = { itemId, count }
  if (index === -1) return [...rest, stack]
  return [...rest.slice(0, index), stack, ...rest.slice(index)]
}

function withoutItem(outfit: Outfit, itemId: string): Outfit {
  return Object.fromEntries(Object.entries(outfit).filter(([, worn]) => worn !== itemId))
}

/** Sells one of `itemId` (a worn item is taken off first, placed decor taken out of its slot). */
export function sellItem(
  snapshot: GameSnapshot,
  itemId: string,
  config: EngineConfig,
): ItemResult<{ readonly amount: number; readonly levelUp: LevelUp | null }> {
  const item = findItem(itemId, config)
  if (item === undefined) return { ok: false, error: { code: 'UNKNOWN_ITEM', itemId } }
  const { cash, inventory } = snapshot.player
  if (isDecor(item)) return sellDecor(snapshot, item, config)
  if (isWearable(item)) {
    const owned = inventory.wearables.find((entry) => entry.itemId === itemId)
    if (owned === undefined) return { ok: false, error: { code: 'NOT_OWNED', itemId } }
    if (isPrestigeKept(owned)) return { ok: false, error: { code: 'PRESTIGE_KEPT', itemId } }
    const amount = resaleValue(item, owned.acquiredMinute, snapshot.clock.minute, config)
    const next: Inventory = {
      ...inventory,
      wearables: inventory.wearables.filter((entry) => entry.itemId !== itemId),
      outfit: withoutItem(inventory.outfit, itemId),
    }
    const sold = auditItem(withInventory(snapshot, next, cash + amount), item, 'sell', config)
    return { ok: true, snapshot: sold.snapshot, amount, levelUp: sold.levelUp }
  }
  const count = giftCount(inventory, itemId)
  if (count === 0) return { ok: false, error: { code: 'NOT_OWNED', itemId } }
  const amount = resaleValue(item, snapshot.clock.minute, snapshot.clock.minute, config)
  const next = { ...inventory, gifts: setGiftCount(inventory.gifts, itemId, count - 1) }
  return { ok: true, snapshot: withInventory(snapshot, next, cash + amount), amount, levelUp: null }
}

function sellDecor(
  snapshot: GameSnapshot,
  item: DecorDef,
  config: EngineConfig,
): ItemResult<{ readonly amount: number; readonly levelUp: LevelUp | null }> {
  const { cash, inventory, apartment } = snapshot.player
  const itemId = item.id
  const owned = inventory.decor.find((entry) => entry.itemId === itemId)
  if (owned === undefined) return { ok: false, error: { code: 'NOT_OWNED', itemId } }
  if (isPrestigeKept(owned)) return { ok: false, error: { code: 'PRESTIGE_KEPT', itemId } }
  const amount = resaleValue(item, owned.acquiredMinute, snapshot.clock.minute, config)
  const placed = Object.fromEntries(
    Object.entries(apartment.placed).filter(([, placedId]) => placedId !== itemId),
  )
  const sold = settleLevel(
    {
      ...snapshot.player,
      cash: cash + amount,
      inventory: { ...inventory, decor: inventory.decor.filter((entry) => entry !== owned) },
      apartment: { ...apartment, placed },
    },
    snapshot.clock.minute,
    'home',
    config,
  )
  return { ok: true, snapshot: { ...snapshot, player: sold.player }, amount, levelUp: sold.levelUp }
}

/**
 * Wears an owned wearable in `slot`, replacing whatever was there. Its stat effects land the
 * first time this copy is worn.
 */
export function equipItem(
  snapshot: GameSnapshot,
  itemId: string,
  slot: string,
  config: EngineConfig,
): ItemResult {
  const item = findItem(itemId, config)
  if (item === undefined) return { ok: false, error: { code: 'UNKNOWN_ITEM', itemId } }
  if (!isWearable(item)) return { ok: false, error: { code: 'NOT_WEARABLE', itemId } }
  if (slot !== item.slot) {
    return { ok: false, error: { code: 'WRONG_SLOT', itemId, slot, itemSlot: item.slot } }
  }
  const { inventory, stats } = snapshot.player
  const owned = inventory.wearables.find((entry) => entry.itemId === itemId)
  if (owned === undefined) return { ok: false, error: { code: 'NOT_OWNED', itemId } }
  const next: Inventory = {
    ...inventory,
    wearables: owned.worn
      ? inventory.wearables
      : inventory.wearables.map((entry) =>
          entry.itemId === itemId ? { ...entry, worn: true } : entry,
        ),
    outfit: { ...inventory.outfit, [item.slot]: itemId },
  }
  const nextStats = owned.worn ? stats : applyStatChanges(stats, item.statEffects, config)
  const equipped = withInventory(snapshot, next)
  return { ok: true, snapshot: { ...equipped, player: { ...equipped.player, stats: nextStats } } }
}

/** Takes off whatever is worn in `slot` (a no-op when the slot is empty). */
export function unequipSlot(snapshot: GameSnapshot, slot: string): ItemResult {
  if (!isItemSlot(slot)) return { ok: false, error: { code: 'UNKNOWN_SLOT', slot } }
  const { inventory } = snapshot.player
  if (inventory.outfit[slot] === undefined) return { ok: true, snapshot }
  const outfit = Object.fromEntries(
    Object.entries(inventory.outfit).filter(([key]) => key !== slot),
  )
  return { ok: true, snapshot: withInventory(snapshot, { ...inventory, outfit }) }
}

/** Checks an untrusted gift target: `'yourself'` or exactly `{ npcId }` with a valid NPC id. */
export function parseGiftTarget(raw: unknown): GiftTarget | null {
  if (raw === 'yourself') return 'yourself'
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'npcId') return null
  const npcId = toNpcId((raw as { npcId?: unknown }).npcId)
  return npcId === null ? null : { npcId }
}

export interface GiftUse {
  readonly itemId: string
  readonly target: GiftTarget
}

/**
 * Uses (consumes) one gift on the player or an NPC. Used on the player, its stat effects land;
 * used on an NPC, the caller resolves the NPC's reaction from the returned `gift`.
 */
export function consumeGift(
  snapshot: GameSnapshot,
  itemId: string,
  target: GiftTarget,
  config: EngineConfig,
): ItemResult<{ readonly gift: GiftUse }> {
  // Re-checked at runtime: the target may come from untrusted input despite its type.
  const checked = parseGiftTarget(target)
  if (checked === null) return { ok: false, error: { code: 'INVALID_TARGET' } }
  const item = findItem(itemId, config)
  if (item === undefined) return { ok: false, error: { code: 'UNKNOWN_ITEM', itemId } }
  if (!isGift(item)) return { ok: false, error: { code: 'NOT_A_GIFT', itemId } }
  const { inventory, stats } = snapshot.player
  const count = giftCount(inventory, itemId)
  if (count === 0) return { ok: false, error: { code: 'NOT_OWNED', itemId } }
  const next = { ...inventory, gifts: setGiftCount(inventory.gifts, itemId, count - 1) }
  const consumed = withInventory(snapshot, next)
  const nextStats =
    checked === 'yourself' ? applyStatChanges(stats, item.statEffects, config) : stats
  return {
    ok: true,
    snapshot: { ...consumed, player: { ...consumed.player, stats: nextStats } },
    gift: { itemId, target: checked },
  }
}

/** How many of a gift the player holds. */
export function giftCount(inventory: Inventory, itemId: string): number {
  return inventory.gifts.find((stack) => stack.itemId === itemId)?.count ?? 0
}
