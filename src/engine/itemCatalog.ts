/**
 * The in-game cash item catalog as the engine sees it (data/items/items.json). The file is
 * validated in full by `ItemsFileSchema` (src/lib/data/schemas/content.ts) in the data tests,
 * which gate every build; here the JSON is only narrowed to the engine's types, and anything
 * that does not fit throws at load (fail fast), without pulling classic zod into the client.
 */
import type { RarityTier } from '@/lib/data/schemas/config'
import type { DecorFit, Item } from '@/lib/data/schemas/content'
import { STAT_KEYS, type StatChanges } from './stats'

/** Outfit slots, in display order. Mirrors ITEM_SLOTS in src/lib/data/schemas/content.ts. */
export const ITEM_SLOTS = ['top', 'bottom', 'shoes', 'accessory', 'face'] as const
export type ItemSlot = (typeof ITEM_SLOTS)[number]

const CATEGORIES = ['clothing', 'makeup', 'gift', 'decor', 'upgrade'] as const
/** Mirrors DECOR_FITS in src/lib/data/schemas/content.ts. */
export const DECOR_FITS = ['wall', 'floor', 'surface'] as const satisfies readonly DecorFit[]
export type { DecorFit }
const RARITIES = ['common', 'medium', 'rare'] as const
type Category = (typeof CATEGORIES)[number]

interface ItemBase {
  readonly id: string
  readonly nameKey: string
  readonly descriptionKey: string
  readonly rarity: RarityTier
  readonly currency: 'cash'
  /** Whole in-game dollars. */
  readonly price: number
  /** Whole dollars it sells back for on the day it is bought; always below `price`. */
  readonly sellValue: number
  /**
   * Clout the item is worth while the player owns (or wears) it. It is computed from what is
   * owned (src/engine/clout.ts `itemClout`), never accumulated, so a sold item stops counting.
   */
  readonly cloutValue: number
  /** Style points while worn; the outfit's total multiplies clout gains (src/engine/clout.ts). */
  readonly styleValue: number
  readonly statEffects: StatChanges
}

/** Clothing or makeup: owned once, worn in its slot. */
export interface WearableDef extends ItemBase {
  readonly category: 'clothing' | 'makeup'
  readonly slot: ItemSlot
}

/** A gift: stacks, and is consumed when used on yourself or an NPC. */
export interface GiftDef extends ItemBase {
  readonly category: 'gift'
}

/** A decor item's colour variant: a palette token and its colour name's copy key. */
export interface DecorVariant {
  readonly id: string
  readonly token: string
  readonly nameKey: string
}

/**
 * Decor (S16): owned once and placed in a slot of its kind in the player's home. It is worth no
 * item clout or style (`cloutValue` and `styleValue` are 0); while placed it adds `homeScore` to
 * the home's score (src/engine/home.ts).
 */
export interface DecorDef extends ItemBase {
  readonly category: 'decor'
  readonly decor: {
    readonly fits: DecorFit
    readonly homeScore: number
    /** At least two; the first is what a new purchase shows. */
    readonly variants: readonly DecorVariant[]
  }
}

/** Apartment upgrades: listed in the catalog, sold by a later task. */
export interface OtherItemDef extends ItemBase {
  readonly category: 'upgrade'
}

export type ItemDef = WearableDef | GiftDef | DecorDef | OtherItemDef

export function isWearable(item: ItemDef): item is WearableDef {
  return item.category === 'clothing' || item.category === 'makeup'
}

export function isGift(item: ItemDef): item is GiftDef {
  return item.category === 'gift'
}

export function isDecor(item: ItemDef): item is DecorDef {
  return item.category === 'decor'
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
}

const isDollars = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/** Shape the JSON import may have; every field is re-checked below. */
type RawItem = { readonly [K in keyof Item]?: unknown }

function narrow(raw: RawItem, index: number): ItemDef {
  const fail = (field: string): never => {
    throw new Error(`data/items/items.json: items[${index}].${field} does not fit the engine`)
  }
  const { id, nameKey, descriptionKey, category, slot, rarity, currency } = raw
  const { price, sellValue, cloutValue, styleValue, statEffects, decor } = raw
  if (typeof id !== 'string') return fail('id')
  if (typeof nameKey !== 'string') return fail('nameKey')
  if (typeof descriptionKey !== 'string') return fail('descriptionKey')
  if (!oneOf<Category>(category, CATEGORIES)) return fail('category')
  if (!oneOf<RarityTier>(rarity, RARITIES)) return fail('rarity')
  if (currency !== 'cash') return fail('currency')
  if (!isDollars(price) || price < 1) return fail('price')
  if (!isDollars(sellValue) || sellValue >= price) return fail('sellValue')
  if (!isDollars(cloutValue)) return fail('cloutValue')
  if (!isDollars(styleValue) || (category === 'gift' && styleValue !== 0)) return fail('styleValue')
  if (typeof statEffects !== 'object' || statEffects === null) return fail('statEffects')
  const effects: Partial<Record<(typeof STAT_KEYS)[number], number>> = {}
  for (const [key, value] of Object.entries(statEffects)) {
    if (!oneOf(key, STAT_KEYS) || typeof value !== 'number' || !Number.isInteger(value)) {
      return fail(`statEffects.${key}`)
    }
    effects[key] = value
  }
  const base = {
    id,
    nameKey,
    descriptionKey,
    rarity,
    currency,
    price,
    sellValue,
    cloutValue,
    styleValue,
    statEffects: effects,
  } as const
  if (category === 'clothing' || category === 'makeup') {
    if (!oneOf<ItemSlot>(slot, ITEM_SLOTS)) return fail('slot')
    if ((category === 'makeup') !== (slot === 'face')) return fail('slot')
    return { ...base, category, slot }
  }
  if (slot !== undefined) return fail('slot')
  if (category === 'decor') {
    if (cloutValue !== 0) return fail('cloutValue')
    if (styleValue !== 0) return fail('styleValue')
    return { ...base, category, decor: narrowDecor(decor, fail) }
  }
  if (decor !== undefined) return fail('decor')
  return { ...base, category }
}

function narrowDecor(raw: unknown, fail: (field: string) => never): DecorDef['decor'] {
  if (typeof raw !== 'object' || raw === null) return fail('decor')
  const { fits, homeScore, variants } = raw as Record<string, unknown>
  if (!oneOf<DecorFit>(fits, DECOR_FITS)) return fail('decor.fits')
  if (!isDollars(homeScore) || homeScore < 1) return fail('decor.homeScore')
  if (!Array.isArray(variants) || variants.length < 2) return fail('decor.variants')
  const list = variants.map((variant: unknown, i): DecorVariant => {
    const { id, token, nameKey } = (variant ?? {}) as Record<string, unknown>
    if (typeof id !== 'string' || typeof token !== 'string' || typeof nameKey !== 'string') {
      return fail(`decor.variants[${i}]`)
    }
    return { id, token, nameKey }
  })
  if (new Set(list.map((variant) => variant.id)).size !== list.length) {
    return fail('decor.variants')
  }
  return { fits, homeScore, variants: list }
}

/** The engine catalog from the items file's `items` array. Throws on a duplicate id. */
export function catalogFromJson(items: readonly RawItem[]): readonly ItemDef[] {
  const catalog = items.map(narrow)
  const ids = new Set(catalog.map((item) => item.id))
  if (ids.size !== catalog.length) throw new Error('data/items/items.json: duplicate item id')
  return catalog
}
