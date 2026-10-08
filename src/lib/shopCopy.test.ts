import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import { ITEM_SLOTS, shopItems } from '@/engine/items'
import { createCopy } from '@/lib/copy'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { formatMoney } from './format'
import {
  alreadyOwnedLabel,
  boughtNotice,
  buyLabel,
  cannotAffordLabel,
  equipLabel,
  giftCountLine,
  giftUsedOnSelfNotice,
  itemDescription,
  itemName,
  rarityName,
  sellLabel,
  slotName,
  soldNotice,
  unequipLabel,
  useGiftOnSelfLabel,
} from './shopCopy'

const plain = { copy: createCopy(baseCopy, { id: 'none', strings: {} }) }

describe('shop copy', () => {
  it('names and describes every shop item in every pack', () => {
    for (const pack of Object.values(slangPacks)) {
      const copy = createCopy(baseCopy, pack)
      for (const item of shopItems(engineConfig)) {
        expect(itemName(item.id, { copy }).length).toBeGreaterThan(0)
        expect(itemDescription(item.id, { copy }).length).toBeGreaterThan(0)
      }
    }
  })

  it('formats prices through formatMoney', () => {
    expect(buyLabel('designer-puffer', plain)).toBe(`Buy Designer puffer for ${formatMoney(320)}`)
    expect(buyLabel('designer-puffer', plain)).toContain('$320')
    expect(sellLabel('designer-puffer', 1192, plain)).toBe('Sell Designer puffer for $1,192')
    expect(boughtNotice('cargo-pants', 28, plain)).toBe('Bought Cargo pants for $28.')
    expect(soldNotice('cargo-pants', 11, plain)).toBe('Sold Cargo pants for $11.')
  })

  it('a buy the player cannot afford names the price, the cash and the shortfall', () => {
    expect(cannotAffordLabel('cargo-pants', 27, plain)).toBe(
      'Cargo pants costs $28. You have $27, so you need $1 more.',
    )
  })

  it('labels outfit, ownership and gift controls', () => {
    expect(equipLabel('gold-hoops', 'accessory', plain)).toBe('Wear Gold hoops (Accessory)')
    expect(unequipLabel('glitter-liner', 'face', plain)).toBe('Take off Glitter liner (Makeup)')
    expect(alreadyOwnedLabel('gold-hoops', plain)).toBe('Gold hoops: you already own it.')
    expect(useGiftOnSelfLabel('bodega-flowers', plain)).toBe('Use Bodega flowers on yourself')
    expect(giftUsedOnSelfNotice('bodega-flowers', plain)).toBe(
      'You used Bodega flowers on yourself.',
    )
    expect(giftCountLine('bodega-flowers', 3, plain)).toBe('Bodega flowers: 3 left')
  })

  it('names every slot and rarity', () => {
    for (const slot of ITEM_SLOTS) expect(slotName(slot).length).toBeGreaterThan(0)
    expect(rarityName('rare', plain)).toBe('Rare')
  })

  it('throws on an unknown item rather than rendering half a label', () => {
    expect(() => buyLabel('nope')).toThrow(/no item "nope"/)
  })
})
