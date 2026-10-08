/** Balance config for the economy: jobs, rent escalation and clout levels (S11), housing (S12). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import { cheapestHome } from '@/engine/rent'
import { BalanceConfigSchema, JOB_IDS, type BalanceConfig } from './schemas/config'
import { balance } from './config'

const valid = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../data/config/balance.json'), 'utf8'),
) as BalanceConfig

const parses = (patch: Partial<BalanceConfig>) =>
  BalanceConfigSchema.safeParse({ ...valid, ...patch }).success

describe('jobs config', () => {
  it('keeps the CLAUDE.md anchors: 4-hour shifts, delivery costs the most energy', () => {
    expect(balance.jobs.shiftHours).toBe(4)
    const delivery = balance.jobs.energyCostPerShift.delivery
    for (const id of JOB_IDS.filter((job) => job !== 'delivery')) {
      expect(delivery, id).toBeGreaterThan(balance.jobs.energyCostPerShift[id])
    }
  })

  it('gates junior dev, and only junior dev, behind a clout level above the first', () => {
    expect(Object.keys(balance.jobs.requiredCloutLevel)).toEqual(['junior-dev'])
    const level = balance.jobs.requiredCloutLevel['junior-dev']
    expect(balance.clout.levels.findIndex((entry) => entry.id === level)).toBeGreaterThan(0)
  })

  it('rejects an unknown required level, an energy cost above the max and a fractional shift', () => {
    const jobs = valid.jobs
    expect(parses({ jobs: { ...jobs, requiredCloutLevel: { 'junior-dev': 'mayor' } } })).toBe(false)
    expect(
      parses({
        jobs: { ...jobs, energyCostPerShift: { ...jobs.energyCostPerShift, retail: 101 } },
      }),
    ).toBe(false)
    expect(parses({ jobs: { ...jobs, shiftHours: 4.01 } })).toBe(false)
    expect(parses({ jobs: { ...jobs, shiftHours: 25 } })).toBe(false)
  })

  it('the engine reads the same numbers', () => {
    expect(engineConfig.jobs).toEqual(balance.jobs)
    expect(engineConfig.rentPerWeek).toEqual(balance.rentPerWeek)
    expect(engineConfig.startHome).toBe(balance.start.home)
  })
})

describe('rent config', () => {
  it('has one late fee for each miss before eviction', () => {
    expect(balance.rent.lateFees).toHaveLength(balance.rent.evictAfterMissed - 1)
    expect(parses({ rent: { lateFees: [0], evictAfterMissed: 3 } })).toBe(false)
    expect(parses({ rent: { lateFees: [], evictAfterMissed: 1 } })).toBe(true)
    expect(parses({ rent: { lateFees: [-5, 30], evictAfterMissed: 3 } })).toBe(false)
  })
})

describe('clout levels config', () => {
  it('has the six S13 levels, starting at Nobody with 0 clout', () => {
    expect(balance.clout.levels.map((level) => level.id)).toEqual([
      'nobody',
      'local',
      'scene-regular',
      'known',
      'famous',
      'icon',
    ])
    expect(balance.clout.levels[0]?.minClout).toBe(0)
  })

  it.each([
    ['a first level above 0', [{ id: 'nobody', minClout: 5 }]],
    [
      'thresholds that do not rise',
      [
        { id: 'nobody', minClout: 0 },
        { id: 'local', minClout: 0 },
      ],
    ],
    [
      'a repeated id',
      [
        { id: 'nobody', minClout: 0 },
        { id: 'nobody', minClout: 10 },
      ],
    ],
    ['no levels', []],
  ])('rejects %s', (_label, levels) => {
    const jobs = { ...valid.jobs, requiredCloutLevel: {} }
    expect(parses({ jobs, clout: { ...valid.clout, levels } })).toBe(false)
  })
})

describe('clout rules config (S13, TUNE-4 placeholders)', () => {
  const clout = (patch: Partial<BalanceConfig['clout']>) =>
    parses({ clout: { ...valid.clout, ...patch } })

  it('ships a valid set', () => {
    expect(clout({})).toBe(true)
  })

  it('rejects a premium cap that would let premium clout alone reach the top level', () => {
    const top = valid.clout.levels.at(-1)?.minClout ?? 0
    expect(clout({ caps: { byCurrency: { usd: top } } })).toBe(false)
    expect(clout({ caps: { byCurrency: { usd: top - 1 } } })).toBe(true)
  })

  it('rejects style on a source it may not multiply, or listed twice', () => {
    const style = valid.clout.style
    expect(clout({ style: { ...style, appliesTo: ['item'] as never } })).toBe(false)
    expect(clout({ style: { ...style, appliesTo: ['premium'] as never } })).toBe(false)
    expect(clout({ style: { ...style, appliesTo: ['flex', 'flex'] } })).toBe(false)
    // Nightlife is flavour only: style can never multiply club clout.
    expect(clout({ style: { ...style, appliesTo: ['club'] as never } })).toBe(false)
  })

  it('rejects flexing at clubs', () => {
    const flex = valid.clout.flex
    expect(clout({ flex: { ...flex, venueTypes: ['boutique', 'club'] } })).toBe(false)
    expect(clout({ flex: { ...flex, venueTypes: ['boutique'] } })).toBe(true)
  })

  it('rejects viral chances outside 0..1 or a base above the cap', () => {
    const viral = valid.clout.flex.viral
    const flex = (patch: Partial<typeof viral>) =>
      clout({ flex: { ...valid.clout.flex, viral: { ...viral, ...patch } } })
    expect(flex({ maxChance: 1.5 })).toBe(false)
    expect(flex({ baseChance: -0.1 })).toBe(false)
    expect(flex({ baseChance: 0.5, maxChance: 0.4 })).toBe(false)
  })
})

describe('housing config', () => {
  const moveIn = (moveInCost: Record<string, number>) =>
    parses({ housing: { moveInCost } } as Partial<BalanceConfig>)

  it('prices every home but the lowest-rent one, and the engine reads the same numbers', () => {
    expect(Object.keys(balance.housing.moveInCost).sort()).toEqual([
      'brooklyn-1br',
      'manhattan-loft',
    ])
    expect(engineConfig.housing).toEqual(balance.housing)
    expect(engineConfig.costs).toEqual(balance.costs)
  })

  it.each([
    [
      'a cost for the lowest-rent home',
      { 'queens-room': 0, 'brooklyn-1br': 400, 'manhattan-loft': 1000 },
    ],
    ['a missing home', { 'brooklyn-1br': 400 }],
    ['an unknown home', { 'brooklyn-1br': 400, 'manhattan-loft': 1000, 'bronx-studio': 300 }],
    ['a negative cost', { 'brooklyn-1br': -1, 'manhattan-loft': 1000 }],
    ['a fractional cost', { 'brooklyn-1br': 400.5, 'manhattan-loft': 1000 }],
  ])('rejects %s', (_label, moveInCost) => {
    expect(moveIn(moveInCost)).toBe(false)
  })

  it('follows the lowest rent when it moves', () => {
    const rentPerWeek = { 'queens-room': 600, 'brooklyn-1br': 520, 'manhattan-loft': 1100 }
    const housing = { moveInCost: { 'queens-room': 300, 'manhattan-loft': 1000 } }
    expect(parses({ rentPerWeek, housing })).toBe(true)
    expect(parses({ rentPerWeek })).toBe(false)
  })

  it('on a tie for the lowest rent, exempts the same home the engine evicts to', () => {
    const rentPerWeek = { 'queens-room': 520, 'brooklyn-1br': 280, 'manhattan-loft': 280 }
    const evictTo = cheapestHome({ ...engineConfig, rentPerWeek })
    expect(evictTo).toBe('brooklyn-1br')
    const others = { 'queens-room': 300, 'manhattan-loft': 1000 }
    expect(parses({ rentPerWeek, housing: { moveInCost: others } })).toBe(true)
    const wrongOne = { 'queens-room': 300, 'brooklyn-1br': 400 }
    expect(parses({ rentPerWeek, housing: { moveInCost: wrongOne } })).toBe(false)
  })
})
