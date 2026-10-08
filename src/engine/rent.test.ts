import { describe, expect, it } from 'vitest'
import { engineConfig, type EngineConfig, type HomeId } from './config'
import { advanceMinutes, initialSnapshot, tick, type GameSnapshot } from './game'
import { cheapestHome, homeIds, nextRentDueDay, settleRent, type RentEvent } from './rent'

/** Fixed numbers so these tests do not move when balance.json is tuned. */
const config: EngineConfig = {
  ...engineConfig,
  startCash: 150,
  startHome: 'queens-room',
  rentPerWeek: { 'queens-room': 280, 'brooklyn-1br': 520, 'manhattan-loft': 1100 },
  rent: { lateFees: [0, 30], evictAfterMissed: 3 },
}

const DAY = 24 * 60
const WEEK = 7 * DAY
const START = 480

function snapshotWith(overrides: {
  minute?: number
  cash?: number
  home?: HomeId
  rent?: GameSnapshot['player']['rent']
}): GameSnapshot {
  const base = initialSnapshot(config)
  return {
    clock: { minute: overrides.minute ?? START, remainderMs: 0 },
    player: {
      ...base.player,
      cash: overrides.cash ?? base.player.cash,
      home: overrides.home ?? base.player.home,
      rent: overrides.rent ?? base.player.rent,
    },
  }
}

/** Advances to an absolute minute. */
function advanceTo(snapshot: GameSnapshot, minute: number, cfg: EngineConfig = config) {
  return advanceMinutes(snapshot, minute - snapshot.clock.minute, cfg)
}

const kinds = (events: readonly RentEvent[]) => events.map((event) => event.kind)

describe('rent is due every 7 game days', () => {
  it('nothing is charged before the first boundary, even one minute short', () => {
    const result = advanceTo(snapshotWith({ cash: 1000 }), WEEK - 1)
    expect(result.rent).toEqual([])
    expect(result.snapshot.player.cash).toBe(1000)
  })

  it('charges the home rent exactly at the midnight that starts day 8', () => {
    const result = advanceTo(snapshotWith({ cash: 1000 }), WEEK)
    expect(result.rent).toEqual([
      { kind: 'paid', day: 8, home: 'queens-room', rent: 280, arrears: 0 },
    ])
    expect(result.snapshot.player.cash).toBe(720)
    expect(result.snapshot.player.rent).toEqual({ owed: 0, missed: 0 })
  })

  it('charges once per boundary on a multi-week jump', () => {
    const result = advanceTo(snapshotWith({ cash: 5000, home: 'brooklyn-1br' }), 3 * WEEK + 5)
    expect(result.rent.map((event) => event.day)).toEqual([8, 15, 22])
    expect(kinds(result.rent)).toEqual(['paid', 'paid', 'paid'])
    expect(result.snapshot.player.cash).toBe(5000 - 3 * 520)
  })

  it('charges the rent of the current home', () => {
    const loft = advanceTo(snapshotWith({ cash: 2000, home: 'manhattan-loft' }), WEEK)
    expect(loft.snapshot.player.cash).toBe(900)
  })

  it('never double-charges when the same span is split into many advances', () => {
    const whole = advanceTo(snapshotWith({ cash: 3000 }), 4 * WEEK + 77)
    let split = snapshotWith({ cash: 3000 })
    const events: RentEvent[] = []
    for (const step of [1, WEEK - START - 1, 1, 0, 600, 2 * WEEK, WEEK + 76, 1, 1]) {
      const next = advanceMinutes(split, Math.min(step, 4 * WEEK + 77 - split.clock.minute), config)
      events.push(...next.rent)
      split = next.snapshot
    }
    expect(split.clock.minute).toBe(4 * WEEK + 77)
    expect(events).toEqual(whole.rent)
    expect(split.player).toEqual(whole.snapshot.player)
    expect(whole.snapshot.player.cash).toBe(3000 - 4 * 280)
  })

  it('passive ticks across the boundary charge once', () => {
    let snapshot = snapshotWith({ cash: 500, minute: WEEK - 1 })
    const events: RentEvent[] = []
    for (let i = 0; i < 5; i++) {
      const next = tick(snapshot, 3000, { visible: true, speed: 1 }, config)
      events.push(...next.rent)
      snapshot = next.snapshot
    }
    expect(snapshot.clock.minute).toBeGreaterThan(WEEK)
    expect(kinds(events)).toEqual(['paid'])
    expect(snapshot.player.cash).toBe(220)
  })

  it('reports the next due day', () => {
    expect(nextRentDueDay(START, config)).toBe(8)
    expect(nextRentDueDay(WEEK - 1, config)).toBe(8)
    // At the boundary minute itself, that week's rent has already been charged.
    expect(nextRentDueDay(WEEK, config)).toBe(15)
    expect(nextRentDueDay(3 * WEEK + 100, config)).toBe(29)
  })
})

describe('missed rent escalates to eviction', () => {
  it('step 1: a warning, no fee; the week is owed', () => {
    const result = advanceTo(snapshotWith({ cash: 279 }), WEEK)
    expect(result.rent).toEqual([
      {
        kind: 'missed',
        day: 8,
        home: 'queens-room',
        rent: 280,
        lateFee: 0,
        owed: 280,
        missed: 1,
        missesBeforeEviction: 2,
      },
    ])
    expect(result.snapshot.player.cash).toBe(279)
    expect(result.snapshot.player.rent).toEqual({ owed: 280, missed: 1 })
  })

  it('debt is collected at the next midnight once the player has the cash', () => {
    const owing = snapshotWith({ cash: 300, minute: WEEK + 600, rent: { owed: 280, missed: 1 } })
    const before = advanceTo(owing, 2 * WEEK - 1)
    // Collected at the first midnight (day 9), not later.
    expect(before.rent).toEqual([{ kind: 'arrears-paid', day: 9, amount: 280 }])
    expect(before.snapshot.player).toMatchObject({ cash: 20, rent: { owed: 0, missed: 0 } })
  })

  it('debt is not collected while the cash falls short', () => {
    const owing = snapshotWith({ cash: 100, minute: WEEK + 600, rent: { owed: 280, missed: 1 } })
    const result = advanceTo(owing, 2 * WEEK - 1)
    expect(result.rent).toEqual([])
    expect(result.snapshot.player).toMatchObject({ cash: 100, rent: { owed: 280, missed: 1 } })
  })

  it('step 2: the next due date adds the week and a late fee', () => {
    const owing = snapshotWith({ cash: 100, minute: 2 * WEEK - 1, rent: { owed: 280, missed: 1 } })
    const result = advanceTo(owing, 2 * WEEK)
    expect(result.rent).toEqual([
      expect.objectContaining({
        kind: 'missed',
        day: 15,
        lateFee: 30,
        owed: 280 + 280 + 30,
        missed: 2,
        missesBeforeEviction: 1,
      }),
    ])
  })

  it('a due date paid in full clears back rent and fees with it', () => {
    const owing = snapshotWith({ cash: 900, minute: 2 * WEEK - 1, rent: { owed: 590, missed: 2 } })
    // 590 owed + 280 for this week = 870.
    const result = advanceTo(owing, 2 * WEEK)
    expect(result.rent).toEqual([
      { kind: 'paid', day: 15, home: 'queens-room', rent: 280, arrears: 590 },
    ])
    expect(result.snapshot.player).toMatchObject({ cash: 30, rent: { owed: 0, missed: 0 } })
  })

  it('step 3: eviction moves the player to the lowest-rent home and writes off the debt', () => {
    const owing = snapshotWith({
      cash: 500,
      minute: 3 * WEEK - 1,
      home: 'manhattan-loft',
      rent: { owed: 1100 + 1100 + 30, missed: 2 },
    })
    const result = advanceTo(owing, 3 * WEEK)
    expect(result.rent).toEqual([
      {
        kind: 'evicted',
        day: 22,
        from: 'manhattan-loft',
        to: 'queens-room',
        forgiven: 2230 + 1100,
      },
    ])
    expect(result.snapshot.player).toMatchObject({
      cash: 500,
      home: 'queens-room',
      rent: { owed: 0, missed: 0 },
    })
  })

  it('a broke player walks the whole ladder over a multi-week jump, then pays the cheaper rent', () => {
    const broke = snapshotWith({ cash: 0, home: 'brooklyn-1br' })
    const evicted = advanceTo(broke, 3 * WEEK)
    expect(kinds(evicted.rent)).toEqual(['missed', 'missed', 'evicted'])
    expect(evicted.snapshot.player.home).toBe('queens-room')

    const rich = { ...evicted.snapshot, player: { ...evicted.snapshot.player, cash: 300 } }
    const next = advanceTo(rich, 4 * WEEK)
    expect(next.rent).toEqual([
      { kind: 'paid', day: 29, home: 'queens-room', rent: 280, arrears: 0 },
    ])
  })

  it('the eviction target is computed from the rents, not fixed', () => {
    const brooklynCheapest: EngineConfig = {
      ...config,
      rentPerWeek: { 'queens-room': 400, 'brooklyn-1br': 250, 'manhattan-loft': 1100 },
    }
    expect(cheapestHome(config)).toBe('queens-room')
    expect(cheapestHome(brooklynCheapest)).toBe('brooklyn-1br')
    const owing = snapshotWith({
      cash: 0,
      minute: WEEK - 1,
      home: 'manhattan-loft',
      rent: { owed: 0, missed: 2 },
    })
    const result = advanceTo(owing, WEEK, brooklynCheapest)
    expect(result.rent).toEqual([expect.objectContaining({ kind: 'evicted', to: 'brooklyn-1br' })])
    expect(result.snapshot.player.home).toBe('brooklyn-1br')
  })

  it('follows the configured ladder length', () => {
    const strict: EngineConfig = { ...config, rent: { lateFees: [], evictAfterMissed: 1 } }
    const result = advanceTo(snapshotWith({ cash: 0, home: 'brooklyn-1br' }), WEEK, strict)
    expect(kinds(result.rent)).toEqual(['evicted'])
  })

  it('escalation does not depend on how time was split', () => {
    const whole = advanceTo(snapshotWith({ cash: 10, home: 'brooklyn-1br' }), 3 * WEEK + 1)
    let split = snapshotWith({ cash: 10, home: 'brooklyn-1br' })
    const events: RentEvent[] = []
    while (split.clock.minute < 3 * WEEK + 1) {
      const next = advanceMinutes(split, Math.min(997, 3 * WEEK + 1 - split.clock.minute), config)
      events.push(...next.rent)
      split = next.snapshot
    }
    expect(events).toEqual(whole.rent)
    expect(split.player).toEqual(whole.snapshot.player)
  })
})

describe('settleRent', () => {
  it('returns the same player object when nothing happens', () => {
    const { player } = snapshotWith({})
    expect(settleRent(player, START, START + 600, config).player).toBe(player)
  })

  it('lists every home in config order', () => {
    expect(homeIds(config)).toEqual(['queens-room', 'brooklyn-1br', 'manhattan-loft'])
  })
})

describe('rent edge cases', () => {
  /** A deterministic LCG so the split points are reproducible. */
  function splits(seed: number, total: number, parts: number): number[] {
    let s = seed
    const cuts = new Set<number>()
    while (cuts.size < parts - 1) {
      s = (s * 1103515245 + 12345) % 2 ** 31
      cuts.add(1 + (s % (total - 1)))
    }
    const sorted = [...cuts].sort((a, b) => a - b)
    return [...sorted, total].map((cut, i) => cut - (i === 0 ? 0 : (sorted[i - 1] ?? 0)))
  }

  it.each([
    ['broke', 0, { owed: 0, missed: 0 }],
    ['scraping by', 300, { owed: 0, missed: 0 }],
    ['already in debt', 50, { owed: 280, missed: 1 }],
    ['comfortable', 5000, { owed: 0, missed: 0 }],
  ] as const)(
    'A -> C equals A -> B -> C over 10 weeks for many splits (%s)',
    (_label, cash, rent) => {
      const start = snapshotWith({ cash, rent, home: 'brooklyn-1br' })
      const total = 10 * WEEK + 333
      const whole = advanceMinutes(start, total, config)
      for (const seed of [1, 7, 42, 99]) {
        let current = start
        const events: RentEvent[] = []
        for (const step of splits(seed, total, 25)) {
          const next = advanceMinutes(current, step, config)
          events.push(...next.rent)
          current = next.snapshot
        }
        expect(current.player, `seed ${seed}`).toEqual(whole.snapshot.player)
        expect(events, `seed ${seed}`).toEqual(whole.rent)
      }
    },
  )

  it('a 60-day jump charges 8 weeks and evicts on every third miss in a row', () => {
    const result = advanceTo(snapshotWith({ cash: 0 }), 60 * DAY)
    expect(result.rent.map((e) => [e.kind, e.day])).toEqual([
      ['missed', 8],
      ['missed', 15],
      ['evicted', 22],
      ['missed', 29],
      ['missed', 36],
      ['evicted', 43],
      ['missed', 50],
      ['missed', 57],
    ])
    expect(result.snapshot.player.home).toBe('queens-room')
    expect(result.snapshot.player.rent).toEqual({ owed: 280 + 280 + 30, missed: 2 })
  })

  it('a 60-day jump from the loft evicts to the Queens room at day 22, then pays there', () => {
    // $1000 covers neither $1100 loft week; after eviction the $280 weeks are paid.
    const result = advanceTo(snapshotWith({ cash: 1000, home: 'manhattan-loft' }), 60 * DAY)
    expect(result.rent.map((e) => [e.kind, e.day])).toEqual([
      ['missed', 8],
      ['missed', 15],
      ['evicted', 22],
      ['paid', 29],
      ['paid', 36],
      ['paid', 43],
      ['missed', 50],
      ['missed', 57],
    ])
    expect(result.rent[2]).toEqual({
      kind: 'evicted',
      day: 22,
      from: 'manhattan-loft',
      to: 'queens-room',
      forgiven: 1100 + 1100 + 1100 + 30,
    })
    expect(result.snapshot.player.cash).toBe(1000 - 3 * 280)
    expect(result.snapshot.player.rent).toEqual({ owed: 590, missed: 2 })
  })

  it('cash exactly equal to the rent pays it and leaves $0', () => {
    const result = advanceTo(snapshotWith({ cash: 280 }), WEEK)
    expect(kinds(result.rent)).toEqual(['paid'])
    expect(result.snapshot.player.cash).toBe(0)
  })

  it('cash one dollar short is a miss and keeps every dollar (all or nothing)', () => {
    const result = advanceTo(snapshotWith({ cash: 279 }), WEEK)
    expect(kinds(result.rent)).toEqual(['missed'])
    expect(result.snapshot.player.cash).toBe(279)
  })

  it('debt is collected at the midnight right before a due date, then that week is paid', () => {
    // Owing week 1, with cash for the debt and the next week. Day 14 midnight is the last
    // collection chance before day 15's due date.
    const owing = snapshotWith({ minute: 13 * DAY - 1, cash: 560, rent: { owed: 280, missed: 1 } })
    const atDay14 = advanceTo(owing, 13 * DAY)
    expect(atDay14.rent).toEqual([{ kind: 'arrears-paid', day: 14, amount: 280 }])
    const atDay15 = advanceTo(atDay14.snapshot, 2 * WEEK)
    expect(atDay15.rent).toEqual([
      { kind: 'paid', day: 15, home: 'queens-room', rent: 280, arrears: 0 },
    ])
    expect(atDay15.snapshot.player.cash).toBe(0)
  })

  it('on a due date the debt and the week are one charge, never a separate collection', () => {
    const owing = snapshotWith({ minute: 2 * WEEK - 1, cash: 560, rent: { owed: 280, missed: 1 } })
    const result = advanceTo(owing, 2 * WEEK)
    expect(result.rent).toEqual([
      { kind: 'paid', day: 15, home: 'queens-room', rent: 280, arrears: 280 },
    ])
    expect(result.snapshot.player.cash).toBe(0)
  })

  it('on a due date with cash for the debt but not the week, nothing is paid', () => {
    // All or nothing: $400 covers the $280 debt but not debt + week ($560).
    const owing = snapshotWith({ minute: 2 * WEEK - 1, cash: 400, rent: { owed: 280, missed: 1 } })
    const result = advanceTo(owing, 2 * WEEK)
    expect(result.rent).toEqual([expect.objectContaining({ kind: 'missed', owed: 590, missed: 2 })])
    expect(result.snapshot.player.cash).toBe(400)
  })

  it('ending exactly on the boundary minute and then moving on does not charge again', () => {
    const atBoundary = advanceTo(snapshotWith({ cash: 1000 }), WEEK)
    const onward = advanceMinutes(atBoundary.snapshot, 1, config)
    expect(onward.rent).toEqual([])
    expect(onward.snapshot.player.cash).toBe(720)
  })
})

describe('rent escalation config edges', () => {
  it('evictAfterMissed 1 evicts on the first miss, with no warning step', () => {
    const strict = { ...config, rent: { lateFees: [], evictAfterMissed: 1 } }
    const result = advanceTo(snapshotWith({ cash: 0, home: 'brooklyn-1br' }), WEEK, strict)
    expect(result.rent).toEqual([
      { kind: 'evicted', day: 8, from: 'brooklyn-1br', to: 'queens-room', forgiven: 520 },
    ])
    expect(result.snapshot.player.rent).toEqual({ owed: 0, missed: 0 })
  })

  it('evicted while already in the lowest-rent home: stays there and the debt is written off', () => {
    const result = advanceTo(
      snapshotWith({ minute: 3 * WEEK - 1, cash: 0, rent: { owed: 590, missed: 2 } }),
      3 * WEEK,
    )
    expect(result.rent).toEqual([
      { kind: 'evicted', day: 22, from: 'queens-room', to: 'queens-room', forgiven: 870 },
    ])
    expect(result.snapshot.player.home).toBe('queens-room')
    expect(result.snapshot.player.rent).toEqual({ owed: 0, missed: 0 })
  })

  it('a missed count at or above a lowered evictAfterMissed evicts at the next miss', () => {
    // Engine-level: a snapshot from before the config was tightened (save loading clamps it).
    const tightened = { ...config, rent: { lateFees: [0], evictAfterMissed: 2 } }
    const result = advanceTo(
      snapshotWith({ minute: 2 * WEEK - 1, cash: 0, rent: { owed: 590, missed: 2 } }),
      2 * WEEK,
      tightened,
    )
    expect(kinds(result.rent)).toEqual(['evicted'])
  })

  it('on a tie for the lowest rent the eviction target is the first home in HOME_IDS order', () => {
    const tied: EngineConfig = {
      ...config,
      rentPerWeek: { 'queens-room': 520, 'brooklyn-1br': 280, 'manhattan-loft': 280 },
    }
    expect(cheapestHome(tied)).toBe('brooklyn-1br')
    const result = advanceTo(
      snapshotWith({ minute: 3 * WEEK - 1, cash: 0, rent: { owed: 1, missed: 2 } }),
      3 * WEEK,
      tied,
    )
    expect(result.rent).toEqual([expect.objectContaining({ kind: 'evicted', to: 'brooklyn-1br' })])
  })
})
