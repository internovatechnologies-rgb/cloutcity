import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import { isGift, isWearable, shopItems, type ItemError } from '@/engine/items'
import { createCopy } from './copy'
import { baseCopy, slangPacks } from './copy/all'
import { homeLine, rentOwedLine } from './economyCopy'
import { formatMoney } from './format'
import {
  equippedNotice,
  inventoryItemDetails,
  itemErrorText,
  itemName,
  rarityName,
  resaleLine,
  shopItemDetails,
  slotName,
  stackFullLabel,
  unequippedNotice,
} from './shopCopy'

const plain = { copy: createCopy(baseCopy, { id: 'none', strings: {} }) }
const packs = Object.values(slangPacks).map((pack) => ({ copy: createCopy(baseCopy, pack) }))

const wearable = shopItems(engineConfig).find(isWearable)
const gift = shopItems(engineConfig).find(isGift)
if (wearable === undefined || gift === undefined) throw new Error('shop needs a wearable and gift')

describe('S10a shop and inventory copy', () => {
  it('shows a wearable with its slot, rarity and formatted price', () => {
    expect(shopItemDetails(wearable.id, plain)).toBe(
      `${slotName(wearable.slot, plain)}, ${rarityName(wearable.rarity, plain)}, ${formatMoney(wearable.price)}`,
    )
  })

  it('shows a gift as a gift in place of a slot', () => {
    expect(shopItemDetails(gift.id, plain)).toBe(
      `Gift, ${rarityName(gift.rarity, plain)}, ${formatMoney(gift.price)}`,
    )
    expect(inventoryItemDetails(gift.id, plain)).toBe(rarityName(gift.rarity, plain))
  })

  it('renders every new string in every pack without leftover placeholders', () => {
    for (const options of [plain, ...packs]) {
      const rendered = [
        shopItemDetails(wearable.id, options),
        inventoryItemDetails(wearable.id, options),
        stackFullLabel(gift.id, engineConfig.items.maxGiftStack, options),
        resaleLine(12, options),
        equippedNotice(wearable.id, options),
        unequippedNotice(wearable.id, options),
        homeLine(engineConfig.startHome, options),
        rentOwedLine(0, options),
        rentOwedLine(25, options),
      ]
      for (const text of rendered) expect(text).not.toMatch(/[{}]/)
    }
  })

  it('names the item in the in-voice notices', () => {
    for (const options of [plain, ...packs]) {
      expect(equippedNotice(wearable.id, options)).toContain(itemName(wearable.id, options))
      expect(unequippedNotice(wearable.id, options)).toContain(itemName(wearable.id, options))
    }
  })

  it('turns each engine refusal into player text', () => {
    expect(itemErrorText({ code: 'INSUFFICIENT_FUNDS', required: 40, available: 15 }, plain)).toBe(
      `You need ${formatMoney(40)}. You have ${formatMoney(15)}.`,
    )
    expect(itemErrorText({ code: 'ALREADY_OWNED', itemId: wearable.id }, plain)).toContain(
      itemName(wearable.id, plain),
    )
    expect(itemErrorText({ code: 'STACK_FULL', itemId: gift.id, max: 3 }, plain)).toContain('3')
    const failed = plain.copy('shop.error.failed')
    expect(itemErrorText({ code: 'NOT_OWNED', itemId: wearable.id }, plain)).toBe(failed)
    expect(itemErrorText({ code: 'STACK_FULL', itemId: 'nope', max: 3 }, plain)).toBe(failed)
  })

  it('says what is owed, or that nothing is', () => {
    expect(rentOwedLine(0, plain)).toBe('You owe nothing right now.')
    expect(rentOwedLine(312, plain)).toBe(`Back rent and fees owed: ${formatMoney(312)}.`)
  })
})

describe('every engine item refusal reads as player text in every pack', () => {
  const errors: readonly ItemError[] = [
    { code: 'UNKNOWN_ITEM', itemId: 'nope' },
    { code: 'NOT_FOR_SALE', itemId: wearable.id },
    { code: 'INSUFFICIENT_FUNDS', required: 1234, available: 56 },
    { code: 'ALREADY_OWNED', itemId: wearable.id },
    { code: 'STACK_FULL', itemId: gift.id, max: engineConfig.items.maxGiftStack },
    { code: 'NOT_OWNED', itemId: wearable.id },
    { code: 'NOT_WEARABLE', itemId: gift.id },
    { code: 'WRONG_SLOT', itemId: wearable.id, slot: 'shoes', itemSlot: wearable.slot },
    { code: 'UNKNOWN_SLOT', slot: 'hat' },
    { code: 'NOT_A_GIFT', itemId: wearable.id },
    { code: 'INVALID_TARGET' },
  ]

  it.each(errors.map((error) => [error.code, error] as const))('%s', (_code, error) => {
    for (const options of [plain, ...packs]) {
      const text = itemErrorText(error, options)
      expect(text.trim()).not.toBe('')
      expect(text).not.toMatch(/[{}]/)
      // Never leaks the engine code or a raw id to the player.
      expect(text).not.toContain(error.code)
      if ('itemId' in error) expect(text).not.toContain(error.itemId)
    }
  })

  it('money in a funds refusal comes from formatMoney, in every pack', () => {
    for (const options of [plain, ...packs]) {
      const text = itemErrorText(
        { code: 'INSUFFICIENT_FUNDS', required: 1234, available: 56 },
        options,
      )
      expect(text).toContain(formatMoney(1234))
      expect(text).toContain(formatMoney(56))
    }
  })
})

describe('shop.error.failed in voice', () => {
  const failed: ItemError = { code: 'INVALID_TARGET' }

  it('the nyc pack overrides it, plainly, with the base fallback kept', () => {
    const nyc = slangPacks.nyc
    if (nyc === undefined) throw new Error('no nyc pack')
    const voiced = itemErrorText(failed, { copy: createCopy(baseCopy, nyc) })
    const base = itemErrorText(failed, plain)
    expect(base).toBe(baseCopy.strings['shop.error.failed'])
    expect(voiced).toBe(nyc.strings['shop.error.failed'])
    expect(voiced).not.toBe(base)
    expect(voiced).not.toMatch(/[{}]/)
    expect(voiced).not.toMatch(/\b(best|cheapest|biggest|greatest|most|worst|ever)\b/i)
  })
})
