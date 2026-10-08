import { describe, expect, it } from 'vitest'
import { calendar } from './clock'
import { cloutLevel, findCloutLevel, totalClout } from './clout'
import { engineConfig, type EngineConfig, type JobId } from './config'
import { initialSnapshot, type GameSnapshot } from './game'
import { isJobId, jobIds, jobLock, shiftAction, shiftWage, workShift } from './jobs'
import { withClout } from './test-support'

/** Fixed numbers so these tests do not move when balance.json is tuned. */
const config: EngineConfig = {
  ...engineConfig,
  startCash: 150,
  stats: {
    max: 100,
    start: { energy: 100, hunger: 80, mood: 70 },
    decayPerGameHour: { energy: 3, hunger: 5, mood: 2 },
    atZero: {
      energy: { extraDecayPerGameHour: { mood: 3 }, durationMultiplier: 1.5 },
      hunger: { extraDecayPerGameHour: { energy: 3, mood: 4 }, durationMultiplier: 1 },
      mood: { extraDecayPerGameHour: {}, durationMultiplier: 1.25 },
    },
  },
  jobs: {
    shiftHours: 4,
    hourlyWage: { barista: 14, retail: 16, delivery: 18, 'junior-dev': 35 },
    energyCostPerShift: { barista: 15, retail: 15, delivery: 25, 'junior-dev': 15 },
    requiredCloutLevel: { 'junior-dev': 'local' },
  },
  clout: {
    ...engineConfig.clout,
    levels: [
      { id: 'nobody', minClout: 0 },
      { id: 'local', minClout: 100 },
      { id: 'scene-regular', minClout: 300 },
    ],
  },
}

const DAY = 24 * 60

function snapshotWith(overrides: {
  minute?: number
  cash?: number
  clout?: number
  stats?: Partial<GameSnapshot['player']['stats']>
}): GameSnapshot {
  const base = initialSnapshot(config)
  const snapshot = {
    clock: { minute: overrides.minute ?? base.clock.minute, remainderMs: 0 },
    player: {
      ...base.player,
      cash: overrides.cash ?? base.player.cash,
      stats: { ...base.player.stats, ...overrides.stats },
    },
  }
  return overrides.clout === undefined ? snapshot : withClout(snapshot, overrides.clout, config)
}

function expectOk(result: ReturnType<typeof workShift>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`)
  return result
}

const unlocked = (minute?: number) => snapshotWith({ clout: 100, minute })

describe('jobs', () => {
  it('lists the four anchor jobs', () => {
    expect(jobIds(config)).toEqual(['barista', 'retail', 'delivery', 'junior-dev'])
    expect(isJobId('barista', config)).toBe(true)
    expect(isJobId('toString', config)).toBe(false)
  })

  it.each([
    ['barista', 56],
    ['retail', 64],
    ['delivery', 72],
    ['junior-dev', 140],
  ] as const)('a %s shift pays its hourly wage for 4 hours ($%i)', (jobId, wage) => {
    expect(shiftWage(jobId, config)).toBe(wage)
    const result = expectOk(workShift(unlocked(), jobId, config))
    expect(result.wage).toBe(wage)
    expect(result.snapshot.player.cash).toBe(150 + wage)
  })

  it('delivery costs more energy than every other job', () => {
    const others = jobIds(config).filter((id) => id !== 'delivery')
    const delivery = shiftAction('delivery', config).energyCost
    for (const id of others)
      expect(delivery, id).toBeGreaterThan(shiftAction(id, config).energyCost)
    const tired = (jobId: JobId) =>
      expectOk(workShift(unlocked(), jobId, config)).snapshot.player.stats.energy
    // 100 - cost - 4 h x 3 passive decay.
    expect(tired('barista')).toBe(73)
    expect(tired('delivery')).toBe(63)
  })

  it('fast-forwards the personal clock by 4 hours, charging decay on the way', () => {
    const result = expectOk(workShift(unlocked(), 'barista', config))
    expect(result.durationMin).toBe(240)
    expect(result.snapshot.clock.minute).toBe(480 + 240)
    expect(result.snapshot.player.stats).toEqual({ energy: 73, hunger: 60, mood: 62 })
  })

  it('a shift crosses midnight into the next game day', () => {
    const lateOnDay2 = 2 * DAY - 90
    const result = expectOk(workShift(unlocked(lateOnDay2), 'retail', config))
    expect(result.rollovers).toEqual({ days: 1, weeks: 0 })
    expect(calendar(result.snapshot.clock.minute, config)).toMatchObject({
      day: 3,
      hour: 2,
      minuteOfHour: 30,
    })
  })

  it('a slowed shift takes longer but pays the same', () => {
    const exhausted = snapshotWith({ stats: { energy: 15, mood: 0 } })
    const result = expectOk(workShift(exhausted, 'barista', config))
    expect(result.durationMin).toBe(300)
    expect(result.wage).toBe(56)
  })

  it('refuses a shift without enough energy and changes nothing', () => {
    expect(workShift(snapshotWith({ stats: { energy: 24 } }), 'delivery', config)).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_ENERGY', required: 25, available: 24 },
    })
  })

  it('refuses an unknown job, including inherited object keys', () => {
    for (const id of ['astronaut', 'toString', '__proto__']) {
      expect(workShift(snapshotWith({}), id, config)).toEqual({
        ok: false,
        error: { code: 'UNKNOWN_JOB', jobId: id },
      })
    }
  })

  it('does not mutate the input snapshot', () => {
    const before = unlocked()
    const copy = structuredClone(before)
    workShift(before, 'junior-dev', config)
    expect(before).toEqual(copy)
  })

  it('rent due during a shift is charged before the pay lands', () => {
    // Day 7, 22:00 with $200: the week-1 rent ($280) cannot be paid at midnight, even though
    // cash after the shift would cover it.
    const result = expectOk(
      workShift(snapshotWith({ minute: 7 * DAY - 120, cash: 200 }), 'delivery', config),
    )
    expect(result.rent).toEqual([expect.objectContaining({ kind: 'missed', day: 8, owed: 280 })])
    expect(result.snapshot.player.cash).toBe(272)
  })
})

describe('junior dev is gated by clout level', () => {
  it('is locked at Nobody with a reason naming the level it needs', () => {
    const player = snapshotWith({ clout: 99 }).player
    expect(jobLock(player, 'junior-dev', config)).toEqual({
      jobId: 'junior-dev',
      requiredLevel: 'local',
      currentLevel: 'nobody',
    })
    expect(workShift(snapshotWith({ clout: 99 }), 'junior-dev', config)).toEqual({
      ok: false,
      error: {
        code: 'JOB_LOCKED',
        jobId: 'junior-dev',
        requiredLevel: 'local',
        currentLevel: 'nobody',
      },
    })
  })

  it('unlocks at the required level and stays open above it', () => {
    for (const clout of [100, 299, 300, 10_000]) {
      expect(jobLock(snapshotWith({ clout }).player, 'junior-dev', config), `${clout}`).toBeNull()
      expect(workShift(snapshotWith({ clout }), 'junior-dev', config).ok).toBe(true)
    }
  })

  it('the other jobs are open to a new player', () => {
    for (const id of ['barista', 'retail', 'delivery'] as const) {
      expect(jobLock(initialSnapshot(config).player, id, config), id).toBeNull()
    }
  })

  it('the shipped config locks junior dev for a new player', () => {
    const fresh = initialSnapshot(engineConfig)
    expect(jobLock(fresh.player, 'junior-dev', engineConfig)).not.toBeNull()
  })
})

describe('clout levels', () => {
  it('a player is at the highest level whose threshold they hold', () => {
    expect(cloutLevel(0, config)).toEqual({ id: 'nobody', index: 0, minClout: 0 })
    expect(cloutLevel(99, config).id).toBe('nobody')
    expect(cloutLevel(100, config).id).toBe('local')
    expect(cloutLevel(1_000_000, config)).toEqual({ id: 'scene-regular', index: 2, minClout: 300 })
  })

  it('finds a level by id', () => {
    expect(findCloutLevel('local', config)).toEqual({ id: 'local', index: 1, minClout: 100 })
    expect(findCloutLevel('icon', config)).toBeUndefined()
  })

  it('a new player starts at the lowest shipped level, Nobody', () => {
    const fresh = initialSnapshot(engineConfig).player
    expect(cloutLevel(totalClout(fresh, engineConfig), engineConfig).id).toBe('nobody')
  })
})
