/** S10 item data: data/items/items.json, its schema and the balance `items` config. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import { ITEM_SLOTS as ENGINE_SLOTS } from '@/engine/items'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { BalanceConfigSchema, RARITY_TIERS, type BalanceConfig } from './schemas/config'
import { ITEM_SLOTS, ItemsFileSchema } from './schemas/content'
import { balance, theme } from './config'
import { items } from './content'

const DATA = join(import.meta.dirname, '../../../data')
const rawItems = (
  JSON.parse(readFileSync(join(DATA, 'items/items.json'), 'utf8')) as {
    items: Record<string, unknown>[]
  }
).items
const validBalance = JSON.parse(
  readFileSync(join(DATA, 'config/balance.json'), 'utf8'),
) as BalanceConfig

const wearables = items.filter((item) => item.category === 'clothing' || item.category === 'makeup')
const gifts = items.filter((item) => item.category === 'gift')
const decor = items.filter((item) => item.category === 'decor')

describe('data/items/items.json', () => {
  it('has 12 clothing and makeup items and 3 gifts', () => {
    expect(wearables).toHaveLength(12)
    expect(gifts).toHaveLength(3)
    expect(wearables.some((item) => item.category === 'clothing')).toBe(true)
    expect(wearables.some((item) => item.category === 'makeup')).toBe(true)
  })

  it('the wearables cover all 3 rarity tiers and all 5 slots', () => {
    expect(new Set(wearables.map((item) => item.rarity))).toEqual(new Set(RARITY_TIERS))
    expect(new Set(wearables.map((item) => item.slot))).toEqual(new Set(ITEM_SLOTS))
    expect(ITEM_SLOTS).toHaveLength(5)
  })

  it('every item spells out currency, price, rarity, sellValue, cloutValue, styleValue and statEffects', () => {
    for (const raw of rawItems) {
      for (const field of [
        'currency',
        'price',
        'rarity',
        'sellValue',
        'cloutValue',
        'styleValue',
        'statEffects',
      ]) {
        expect(Object.hasOwn(raw, field), `${String(raw.id)}.${field}`).toBe(true)
      }
      expect(raw.currency).toBe('cash')
    }
  })

  it('styleValue follows rarity (S13): common 1-2, medium 3-5, rare 8-10; gifts and decor 0', () => {
    const band = { common: [1, 2], medium: [3, 5], rare: [8, 10] } as const
    for (const item of items) {
      if (item.category === 'gift' || item.category === 'decor') {
        expect(item.styleValue, item.id).toBe(0)
        continue
      }
      const [min, max] = band[item.rarity]
      expect(item.styleValue, item.id).toBeGreaterThanOrEqual(min)
      expect(item.styleValue, item.id).toBeLessThanOrEqual(max)
    }
  })

  it('sellValue is floor(price * resalePct[rarity] / 100) and below price', () => {
    for (const item of items) {
      expect(item.sellValue, item.id).toBe(
        Math.floor((item.price * balance.items.resalePct[item.rarity]) / 100),
      )
      expect(item.sellValue, item.id).toBeLessThan(item.price)
    }
  })

  it('rarer tiers cost more: every common < every medium < every rare, per category', () => {
    for (const group of [wearables, gifts, decor]) {
      const prices = (tier: string) =>
        group.filter((item) => item.rarity === tier).map((item) => item.price)
      expect(Math.max(...prices('common'))).toBeLessThan(Math.min(...prices('medium')))
      expect(Math.max(...prices('medium'))).toBeLessThan(Math.min(...prices('rare')))
    }
  })

  it('names and descriptions exist in the base copy', () => {
    const keys = new Set(Object.keys(baseCopy.strings))
    const refs = items.flatMap((item) => [item.nameKey, item.descriptionKey])
    expect(refs.filter((key) => !keys.has(key))).toEqual([])
    for (const slot of ITEM_SLOTS) expect(keys.has(`items.slots.${slot}.name`)).toBe(true)
    for (const tier of RARITY_TIERS) expect(keys.has(`items.rarity.${tier}.name`)).toBe(true)
  })

  it('the engine reads the same catalog, slots and rules', () => {
    expect(engineConfig.items.catalog).toEqual(items)
    expect(ENGINE_SLOTS).toEqual(ITEM_SLOTS)
    const { catalog, ...rules } = engineConfig.items
    expect(catalog).toHaveLength(items.length)
    expect(rules).toEqual(balance.items)
  })
})

describe('decor (S16)', () => {
  const HEX_LIKE = /^#?[0-9a-f]{3,8}$/i
  /** A key's text in `pack`, falling back to base like the copy layer (undefined if missing). */
  const renderIn = (pack: string) => (key: string) =>
    slangPacks[pack]?.strings[key] ?? baseCopy.strings[key]

  it('has exactly 6 decor items across all 3 rarity tiers, none about drinking (DEC-12)', () => {
    expect(decor.map((item) => item.id)).toEqual([
      'fairy-string-lights',
      'windowsill-monstera',
      'thrift-flatweave-rug',
      'crate-record-player',
      'custom-neon-sign',
      'cloud-lounge-chair',
    ])
    expect(new Set(decor.map((item) => item.rarity))).toEqual(new Set(RARITY_TIERS))
    const text = decor
      .flatMap((item) => [item.id, baseCopy.strings[item.nameKey] ?? ''])
      .join(' ')
      .toLowerCase()
    expect(text).not.toMatch(/\b(bar|cart|wine|beer|liquor|cocktail|booze|drink)/)
  })

  it('is worth no item clout, style or stat effect, and fits a wall, floor or surface', () => {
    for (const item of decor) {
      expect(item.cloutValue, item.id).toBe(0)
      expect(item.styleValue, item.id).toBe(0)
      expect(item.statEffects, item.id).toEqual({})
      expect(item.decor?.homeScore, item.id).toBeGreaterThanOrEqual(1)
    }
    expect(new Set(decor.map((item) => item.decor?.fits))).toEqual(
      new Set(['wall', 'floor', 'surface']),
    )
  })

  it('every variant names a theme token, and its colour name is unique per item', () => {
    for (const item of decor) {
      const variants = item.decor?.variants ?? []
      expect(variants.length, item.id).toBeGreaterThanOrEqual(2)
      for (const variant of variants) {
        expect(Object.hasOwn(theme.colors, variant.token), `${item.id} ${variant.id}`).toBe(true)
      }
      for (const pack of ['nyc', 'plain']) {
        const render = renderIn(pack)
        const names = variants.map((variant) => render(variant.nameKey))
        expect(new Set(names).size, `${item.id} (${pack})`).toBe(names.length)
      }
    }
  })

  it('every colour name resolves in both packs as words, never a hex code (A11Y-1)', () => {
    const keys = decor.flatMap((item) => item.decor?.variants.map((v) => v.nameKey) ?? [])
    expect(keys.length).toBeGreaterThan(0)
    for (const pack of ['nyc', 'plain']) {
      const render = renderIn(pack)
      for (const key of keys) {
        const name = render(key)
        expect(name, `${key} (${pack})`).toBeTypeOf('string')
        expect(name, `${key} (${pack})`).toMatch(/^[A-Z][a-z]+(?: [a-z]+)*$/)
        expect(HEX_LIKE.test(name ?? '') || (name ?? '#').includes('#'), `${key} (${pack})`).toBe(
          false,
        )
      }
    }
  })
})

describe('ItemSchema', () => {
  const tee = rawItems.find((item) => item.id === 'bodega-graphic-tee')
  const flowers = rawItems.find((item) => item.id === 'bodega-flowers')
  const parses = (item: unknown) => ItemsFileSchema.safeParse({ items: [item] }).success

  it('accepts the shipped tee and flowers', () => {
    expect(parses(tee)).toBe(true)
    expect(parses(flowers)).toBe(true)
  })

  it.each([
    ['a usd currency', { currency: 'usd' }],
    ['no currency', { currency: undefined }],
    ['a sellValue equal to price', { sellValue: 18 }],
    ['a price of 0', { price: 0, sellValue: 0 }],
    ['fractional price', { price: 18.5 }],
    ['negative clout', { cloutValue: -1 }],
    ['negative style', { styleValue: -1 }],
    ['no style', { styleValue: undefined }],
    ['a fractional stat effect', { statEffects: { mood: 1.5 } }],
    ['an unknown stat', { statEffects: { luck: 1 } }],
    ['an unknown slot', { slot: 'hat' }],
    ['clothing in the face slot', { slot: 'face' }],
    ['clothing with no slot', { slot: undefined }],
    ['an unknown rarity', { rarity: 'legendary' }],
    ['no description', { descriptionKey: undefined }],
    ['an extra key', { tradeable: true }],
  ])('rejects %s', (_label, patch) => {
    expect(parses({ ...tee, ...patch })).toBe(false)
  })

  it('decor needs its decor block, worth no clout, style or stat effects, with 2+ variants', () => {
    const lights = rawItems.find((item) => item.id === 'fairy-string-lights')
    expect(parses(lights)).toBe(true)
    const block = (lights as { decor: { variants: unknown[] } }).decor
    expect(parses({ ...lights, decor: undefined })).toBe(false)
    expect(parses({ ...tee, decor: block })).toBe(false)
    expect(parses({ ...lights, cloutValue: 1 })).toBe(false)
    expect(parses({ ...lights, styleValue: 1 })).toBe(false)
    expect(parses({ ...lights, statEffects: { mood: 1 } })).toBe(false)
    expect(parses({ ...lights, slot: 'top' })).toBe(false)
    expect(parses({ ...lights, decor: { ...block, fits: 'ceiling' } })).toBe(false)
    expect(parses({ ...lights, decor: { ...block, homeScore: 0 } })).toBe(false)
    expect(parses({ ...lights, decor: { ...block, variants: block.variants.slice(0, 1) } })).toBe(
      false,
    )
    const [first] = block.variants as { id: string; token: string; nameKey: string }[]
    const variant = (patch: object) => ({
      ...block,
      variants: [{ ...first, ...patch }, ...block.variants.slice(1)],
    })
    expect(parses({ ...lights, decor: variant({ token: '#ff4fa3' }) })).toBe(false)
    expect(parses({ ...lights, decor: variant({ nameKey: 'items.pink.name' }) })).toBe(false)
    expect(parses({ ...lights, decor: { ...block, variants: [first, first] } })).toBe(false)
  })

  it('rejects a gift with a slot and makeup outside the face slot', () => {
    expect(parses({ ...flowers, slot: 'top' })).toBe(false)
    expect(parses({ ...tee, category: 'makeup', slot: 'top' })).toBe(false)
    expect(parses({ ...tee, category: 'makeup', slot: 'face' })).toBe(true)
  })
})

describe('balance.json items', () => {
  const parses = (patch: Partial<BalanceConfig['items']>) =>
    BalanceConfigSchema.safeParse({ ...validBalance, items: { ...validBalance.items, ...patch } })
      .success

  it('rejects resale at or above 100 %, fractional percentages and a zero gift stack', () => {
    expect(parses({ resalePct: { common: 100, medium: 50, rare: 60 } })).toBe(false)
    expect(parses({ minResalePct: 50.5 })).toBe(false)
    expect(parses({ depreciationPctPerGameDay: -1 })).toBe(false)
    expect(parses({ maxGiftStack: 0 })).toBe(false)
    expect(parses({})).toBe(true)
  })
})
