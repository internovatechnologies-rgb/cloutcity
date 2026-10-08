/** S16 home data: data/homes/interiors.json, the balance `home` block and HOME_BOROUGHS. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import { baseCopy } from '@/lib/copy/all'
import { HOME_BOROUGHS, HOME_IDS } from './homes'
import { BalanceConfigSchema, type BalanceConfig } from './schemas/config'
import { BOROUGHS, HomeInteriorsFileSchema } from './schemas/content'
import { balance } from './config'
import { homeInteriors, homes } from './content'

const DATA = join(import.meta.dirname, '../../../data')
const rawInteriors = JSON.parse(readFileSync(join(DATA, 'homes/interiors.json'), 'utf8')) as {
  homes: Record<string, Record<string, unknown>>
}
const validBalance = JSON.parse(
  readFileSync(join(DATA, 'config/balance.json'), 'utf8'),
) as BalanceConfig

const slotIds = (home: (typeof HOME_IDS)[number]) => homeInteriors[home].slots.map((s) => s.id)

describe('data/homes/interiors.json', () => {
  it('Queens has 3 slots, Brooklyn adds a second wall and floor (5), the loft has 7', () => {
    expect(slotIds('queens-room')).toEqual(['wall-1', 'floor-1', 'surface-1'])
    expect(slotIds('brooklyn-1br')).toEqual(['wall-1', 'wall-2', 'floor-1', 'floor-2', 'surface-1'])
    expect(slotIds('manhattan-loft')).toHaveLength(7)
  })

  it('each bigger home keeps every slot of the smaller one, with the same kind (moves keep decor)', () => {
    const kinds = (home: (typeof HOME_IDS)[number]) =>
      new Map(homeInteriors[home].slots.map((slot) => [slot.id, slot.kind]))
    const queens = kinds('queens-room')
    const brooklyn = kinds('brooklyn-1br')
    const loft = kinds('manhattan-loft')
    for (const [id, kind] of queens) expect(brooklyn.get(id), id).toBe(kind)
    for (const [id, kind] of brooklyn) expect(loft.get(id), id).toBe(kind)
  })

  it('every slot name exists in the housing copy', () => {
    const keys = new Set(Object.keys(baseCopy.strings))
    const refs = Object.values(homeInteriors).flatMap((home) => home.slots.map((s) => s.nameKey))
    expect(refs.filter((key) => !keys.has(key) || !key.startsWith('housing.'))).toEqual([])
  })

  it('the engine reads the same slots, in order', () => {
    for (const home of HOME_IDS) {
      expect(engineConfig.home.slots[home]).toEqual(
        homeInteriors[home].slots.map((slot) => ({ id: slot.id, kind: slot.kind })),
      )
    }
  })
})

describe('HomeInteriorsFileSchema', () => {
  const queens = rawInteriors.homes['queens-room'] as {
    room: { widthM: number; depthM: number; heightM: number }
    slots: Record<string, unknown>[]
    window: Record<string, unknown>
    door: Record<string, unknown>
  }
  const withQueens = (patch: Record<string, unknown>) =>
    HomeInteriorsFileSchema.safeParse({
      homes: { ...rawInteriors.homes, 'queens-room': { ...queens, ...patch } },
    }).success
  const withSlot = (index: number, patch: Record<string, unknown>) =>
    withQueens({
      slots: queens.slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)),
    })

  it('accepts the shipped file and rejects a missing or extra home', () => {
    expect(HomeInteriorsFileSchema.safeParse(rawInteriors).success).toBe(true)
    const rest = Object.fromEntries(
      Object.entries(rawInteriors.homes).filter(([id]) => id !== 'manhattan-loft'),
    )
    expect(HomeInteriorsFileSchema.safeParse({ homes: rest }).success).toBe(false)
    expect(
      HomeInteriorsFileSchema.safeParse({ homes: { ...rawInteriors.homes, penthouse: queens } })
        .success,
    ).toBe(false)
  })

  it.each([
    ['a wall slot off every wall', 0, { position: [0, 1.7, -1] }],
    ['a floor slot above the floor', 1, { position: [0.6, 0.5, 0.4] }],
    ['a surface slot on the floor', 2, { position: [-1.45, 0, -0.5] }],
    ['a slot outside the room', 1, { position: [9, 0, 0] }],
    ['an id that does not start with its kind', 1, { id: 'wall-9' }],
    ['an unknown kind', 1, { kind: 'ceiling', id: 'ceiling-1' }],
    ['a turn past 180 degrees', 0, { rotationDeg: 270 }],
    ['an extra key', 0, { price: 5 }],
  ])('rejects %s', (_label, index, patch) => {
    expect(withSlot(index, patch)).toBe(false)
  })

  it('rejects duplicate slot ids, a window wider than its wall and a door off the floor', () => {
    const [first] = queens.slots
    expect(withQueens({ slots: [...queens.slots, first] })).toBe(false)
    expect(withQueens({ window: { ...queens.window, widthM: 10 } })).toBe(false)
    expect(withQueens({ window: { ...queens.window, sillM: 2.5 } })).toBe(false)
    expect(withQueens({ door: { ...queens.door, sillM: 0.3 } })).toBe(false)
    expect(withQueens({ slots: [] })).toBe(false)
  })
})

describe('balance.json home (S16)', () => {
  const parses = (patch: Partial<BalanceConfig['home']>) =>
    BalanceConfigSchema.safeParse({ ...validBalance, home: { ...validBalance.home, ...patch } })
      .success

  it('ships the TUNE-8 placeholders: base scores 0/10/25, clout cap 60, 20 moves kept', () => {
    expect(balance.home).toEqual({
      baseScore: { 'queens-room': 0, 'brooklyn-1br': 10, 'manhattan-loft': 25 },
      maxClout: 60,
      moveLogMax: 20,
    })
    expect(engineConfig.home).toMatchObject(balance.home)
  })

  it('rejects a start home that adds clout, a base above the cap, a cap at the top level and bad numbers', () => {
    const base = validBalance.home.baseScore
    expect(parses({ baseScore: { ...base, 'queens-room': 1 } })).toBe(false)
    expect(parses({ baseScore: { ...base, 'manhattan-loft': 61 } })).toBe(false)
    expect(parses({ maxClout: 5000 })).toBe(false)
    expect(parses({ maxClout: 0 })).toBe(false)
    expect(parses({ moveLogMax: 0 })).toBe(false)
    expect(parses({ baseScore: { ...base, 'brooklyn-1br': 2.5 } })).toBe(false)
    expect(parses({})).toBe(true)
  })
})

describe('HOME_BOROUGHS', () => {
  it('places every home in a borough', () => {
    expect(Object.keys(HOME_BOROUGHS).sort()).toEqual([...HOME_IDS].sort())
    for (const borough of Object.values(HOME_BOROUGHS)) {
      expect(BOROUGHS as readonly string[]).toContain(borough)
    }
  })

  // INT-11: the engine's lock rule (HOME_BOROUGHS) and S05's map placement (homes.json) must agree.
  it('matches the borough each home sits in on the map (data/homes/homes.json)', () => {
    for (const id of HOME_IDS) expect(homes[id].borough).toBe(HOME_BOROUGHS[id])
  })
})
