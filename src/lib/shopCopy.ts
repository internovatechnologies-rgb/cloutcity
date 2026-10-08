/**
 * Player-facing text for the shop and inventory, built from the engine's item catalog through
 * the copy layer. Every price goes through `formatMoney`, never a hand-built "$" string.
 */
import { engineConfig, type EngineConfig } from '@/engine/config'
import {
  findItem,
  isDecor,
  isWearable,
  type ItemDef,
  type ItemError,
  type ItemSlot,
} from '@/engine/items'
import type { RarityTier } from '@/lib/data/schemas/config'
import { copy as activeCopy, isCopyKey, type CopyFn, type CopyKey } from './copy'
import { formatCount, formatMoney } from './format'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/inventory'
import '@/lib/copy/ns/items'
import '@/lib/copy/ns/place'
import '@/lib/copy/ns/shop'

export interface ShopCopyOptions {
  readonly copy?: CopyFn
  readonly config?: EngineConfig
}

function requireKey(key: string, what: string): CopyKey {
  if (!isCopyKey(key)) throw new Error(`No copy key "${key}" for ${what}`)
  return key
}

function item(itemId: string, config: EngineConfig): ItemDef {
  const found = findItem(itemId, config)
  if (found === undefined) throw new Error(`data/items/items.json has no item "${itemId}"`)
  return found
}

export function itemName(itemId: string, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  return copy(requireKey(item(itemId, config).nameKey, `item ${itemId}`))
}

export function itemDescription(itemId: string, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  return copy(requireKey(item(itemId, config).descriptionKey, `item ${itemId}`))
}

export function slotName(slot: ItemSlot, { copy = activeCopy }: ShopCopyOptions = {}): string {
  return copy(requireKey(`items.slots.${slot}.name`, `slot ${slot}`))
}

export function rarityName(rarity: RarityTier, { copy = activeCopy }: ShopCopyOptions = {}) {
  return copy(requireKey(`items.rarity.${rarity}.name`, `rarity ${rarity}`))
}

/** The buy control's label, e.g. "Buy Cargo pants for $28". */
export function buyLabel(itemId: string, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  return copy('shop.buy.label', {
    item: itemName(itemId, options),
    price: formatMoney(item(itemId, config).price),
  })
}

/**
 * Why the player cannot afford an item, naming the shortfall. It doubles as the accessible
 * name of the disabled buy control (CLAUDE.md "Accessibility").
 */
export function cannotAffordLabel(itemId: string, cash: number, options: ShopCopyOptions = {}) {
  const { copy = activeCopy, config = engineConfig } = options
  const { price } = item(itemId, config)
  return copy('shop.buy.locked', {
    item: itemName(itemId, options),
    price: formatMoney(price),
    cash: formatMoney(cash),
    short: formatMoney(Math.max(0, price - cash)),
  })
}

export function alreadyOwnedLabel(itemId: string, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('shop.buy.owned', { item: itemName(itemId, options) })
}

export function boughtNotice(itemId: string, price: number, options: ShopCopyOptions = {}) {
  const { copy = activeCopy } = options
  return copy('shop.buy.done', { item: itemName(itemId, options), price: formatMoney(price) })
}

/** The sell control's label, with the current resale value from the engine. */
export function sellLabel(itemId: string, amount: number, options: ShopCopyOptions = {}) {
  const { copy = activeCopy } = options
  return copy('shop.sell.label', { item: itemName(itemId, options), price: formatMoney(amount) })
}

/** A kept look's Sell button name: why the shop will not buy it (A11Y-2). */
export function keptSellLabel(itemId: string, options: ShopCopyOptions = {}) {
  const { copy = activeCopy } = options
  return copy('inventory.sell.keptLabel', { item: itemName(itemId, options) })
}

export function soldNotice(itemId: string, amount: number, options: ShopCopyOptions = {}) {
  const { copy = activeCopy } = options
  return copy('shop.sell.done', { item: itemName(itemId, options), price: formatMoney(amount) })
}

export function equipLabel(itemId: string, slot: ItemSlot, options: ShopCopyOptions = {}) {
  const { copy = activeCopy } = options
  return copy('inventory.equip.label', {
    item: itemName(itemId, options),
    slot: slotName(slot, options),
  })
}

export function unequipLabel(itemId: string, slot: ItemSlot, options: ShopCopyOptions = {}) {
  const { copy = activeCopy } = options
  return copy('inventory.unequip.label', {
    item: itemName(itemId, options),
    slot: slotName(slot, options),
  })
}

export function useGiftOnSelfLabel(itemId: string, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('inventory.gift.useOnSelf.label', { item: itemName(itemId, options) })
}

export function giftUsedOnSelfNotice(itemId: string, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('inventory.gift.usedOnSelf', { item: itemName(itemId, options) })
}

export function giftCountLine(itemId: string, count: number, options: ShopCopyOptions = {}) {
  const { copy = activeCopy } = options
  return copy('inventory.gift.count', {
    item: itemName(itemId, options),
    count: formatCount(count),
  })
}

/** The kind shown for a shop item: its slot, or "Gift" or "Decor". */
function shopItemKind(found: ItemDef, options: ShopCopyOptions): string {
  const { copy = activeCopy } = options
  if (isWearable(found)) return slotName(found.slot, options)
  return copy(isDecor(found) ? 'shop.item.decor' : 'shop.item.gift')
}

/** The line under a shop item: "Top, Common, $28" (a gift says "Gift", decor "Decor"). */
export function shopItemDetails(itemId: string, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  const found = item(itemId, config)
  return copy('shop.item.details', {
    kind: shopItemKind(found, options),
    rarity: rarityName(found.rarity, options),
    price: formatMoney(found.price),
  })
}

/** The line under an owned wearable: "Top, Common". */
export function inventoryItemDetails(itemId: string, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  const found = item(itemId, config)
  const rarity = rarityName(found.rarity, options)
  if (!isWearable(found)) return rarity
  return copy('inventory.item.details', { slot: slotName(found.slot, options), rarity })
}

export function stackFullLabel(itemId: string, max: number, options: ShopCopyOptions = {}) {
  const { copy = activeCopy } = options
  return copy('shop.buy.stackFull', { item: itemName(itemId, options), count: formatCount(max) })
}

/** "Sells for $14": an owned item's current resale value, from the engine. */
export function resaleLine(amount: number, { copy = activeCopy }: ShopCopyOptions = {}) {
  return copy('inventory.resale', { price: formatMoney(amount) })
}

export function equippedNotice(itemId: string, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('inventory.equipped', { item: itemName(itemId, options) })
}

export function unequippedNotice(itemId: string, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('inventory.unequipped', { item: itemName(itemId, options) })
}

/**
 * The player-facing text for an engine item error. The UI disables what the engine would
 * refuse, so these show only when the state moved under the UI.
 */
export function itemErrorText(error: ItemError, options: ShopCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  switch (error.code) {
    case 'INSUFFICIENT_FUNDS':
      return copy('place.blocked.funds', {
        required: formatMoney(error.required),
        available: formatMoney(error.available),
      })
    case 'ALREADY_OWNED':
      return alreadyOwnedLabel(error.itemId, options)
    case 'PRESTIGE_KEPT':
      return keptSellLabel(error.itemId, options)
    case 'STACK_FULL':
      return findItem(error.itemId, config) === undefined
        ? copy('shop.error.failed')
        : stackFullLabel(error.itemId, error.max, options)
    default:
      return copy('shop.error.failed')
  }
}
