import { describe, expect, it } from 'vitest'
import {
  calendar,
  fastForward,
  initialClock,
  realMsPerGameMinute,
  rollovers,
  tickClock,
  type ClockState,
} from './clock'
import { engineConfig as config } from './config'

const MINUTE_MS = 60_000
const visible1x = { visible: true, speed: 1 }

/** Ticks in steps of at most `stepMs`, like a frame or interval loop. */
function tickFor(clock: ClockState, totalMs: number, stepMs: number, speed = 1): ClockState {
  let next = clock
  for (let left = totalMs; left > 0; left -= stepMs) {
    next = tickClock(next, Math.min(stepMs, left), { visible: true, speed }, config).clock
  }
  return next
}

describe('time math', () => {
  it('runs 1 real minute = 10 game minutes (the CLAUDE.md anchor)', () => {
    expect(config.time.gameMinutesPerRealMinute).toBe(10)
    expect(realMsPerGameMinute(config)).toBe(6000)
    expect(tickFor(initialClock(config), MINUTE_MS, 1000).minute).toBe(480 + 10)
  })

  it('starts on day 1 at 08:00', () => {
    expect(calendar(initialClock(config).minute, config)).toEqual({
      day: 1,
      week: 1,
      dayOfWeek: 1,
      hour: 8,
      minuteOfHour: 0,
      minuteOfDay: 480,
    })
  })

  it('carries partial minutes so many small ticks equal one long one', () => {
    const start = initialClock(config)
    const frames = tickFor(start, 10 * MINUTE_MS, 16)
    const seconds = tickFor(start, 10 * MINUTE_MS, 1000)
    expect(frames.minute).toBe(start.minute + 100)
    expect(seconds).toEqual(frames)
    const half = tickClock(start, 3000, visible1x, config)
    expect(half).toEqual({ clock: { minute: 480, remainderMs: 3000 }, minutes: 0 })
    expect(tickClock(half.clock, 3000, visible1x, config).clock).toEqual({
      minute: 481,
      remainderMs: 0,
    })
  })

  it('runs twice as fast at 2x', () => {
    expect(tickFor(initialClock(config), MINUTE_MS, 1000, 2).minute).toBe(480 + 20)
  })

  it('rejects an unsupported speed', () => {
    expect(() =>
      tickClock(initialClock(config), 1000, { visible: true, speed: 3 }, config),
    ).toThrow(RangeError)
  })

  it('pauses while the tab is hidden, keeping the carried remainder', () => {
    const clock = { minute: 600, remainderMs: 2500 }
    const hidden = tickClock(clock, MINUTE_MS, { visible: false, speed: 1 }, config)
    expect(hidden).toEqual({ clock, minutes: 0 })
    expect(hidden.clock).toBe(clock)
  })

  it('caps one tick at maxTickRealMs so a frozen tab cannot skip time', () => {
    const capped = { ...config, time: { ...config.time, maxTickRealMs: 30_000 } }
    const { clock, minutes } = tickClock(initialClock(capped), 3_600_000, visible1x, capped)
    expect(minutes).toBe(5)
    expect(clock.minute).toBe(480 + 5)
    // The shipped cap is under one game minute of real time per tick at 1x.
    expect(config.time.maxTickRealMs).toBeLessThanOrEqual(realMsPerGameMinute(config))
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects elapsed time %s', (ms) => {
    expect(() => tickClock(initialClock(config), ms, visible1x, config)).toThrow(RangeError)
  })

  it('a zero tick changes nothing', () => {
    const clock = initialClock(config)
    expect(tickClock(clock, 0, visible1x, config).clock).toBe(clock)
  })
})

describe('fast-forward', () => {
  it('jumps by whole game minutes and keeps the passive remainder', () => {
    expect(fastForward({ minute: 480, remainderMs: 1200 }, 240)).toEqual({
      minute: 720,
      remainderMs: 1200,
    })
  })

  it.each([-1, 1.5, Number.NaN])('rejects %s minutes', (minutes) => {
    expect(() => fastForward(initialClock(config), minutes)).toThrow(RangeError)
  })
})

describe('day and week rollover', () => {
  const day = 24 * 60

  it('rolls the day over at midnight', () => {
    expect(rollovers(day - 1, day, config)).toEqual({ days: 1, weeks: 0 })
    expect(calendar(day, config)).toMatchObject({ day: 2, hour: 0, minuteOfDay: 0 })
    expect(rollovers(day - 1, day - 1, config)).toEqual({ days: 0, weeks: 0 })
    expect(rollovers(day, 2 * day - 1, config)).toEqual({ days: 0, weeks: 0 })
  })

  it('counts every midnight crossed in one jump', () => {
    expect(rollovers(480, 480 + 3 * day, config)).toEqual({ days: 3, weeks: 0 })
  })

  it('rolls the rent week over every 7 game days', () => {
    expect(config.time.rentPeriodGameDays).toBe(7)
    const weekEnd = 7 * day
    expect(calendar(weekEnd - 1, config)).toMatchObject({ day: 7, week: 1, dayOfWeek: 7 })
    expect(calendar(weekEnd, config)).toMatchObject({ day: 8, week: 2, dayOfWeek: 1 })
    expect(rollovers(weekEnd - 1, weekEnd, config)).toEqual({ days: 1, weeks: 1 })
    expect(rollovers(0, 15 * day, config)).toEqual({ days: 15, weeks: 2 })
  })
})

/** Deterministic pseudo-random numbers in [0, 1) for fuzzing (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('clock edge cases', () => {
  it('3600 frame-sized ticks of 16.7 ms land on the same minute as 1 s ticks', () => {
    const start = initialClock(config)
    const total = 3600 * 16.7 // 60 120 ms of real time
    const frames = tickFor(start, total, 16.7)
    const seconds = tickFor(start, total, 1000)
    expect(frames.minute).toBe(start.minute + 10)
    expect(frames.minute).toBe(seconds.minute)
    expect(frames.remainderMs).toBeCloseTo(seconds.remainderMs, 6)
  })

  it('switching speed mid-remainder keeps the carried real time', () => {
    // 3 s at 1x carries 3000 ms; 1.5 s at 2x adds 3000 more: exactly one game minute.
    const half = tickClock(initialClock(config), 3000, visible1x, config).clock
    const next = tickClock(half, 1500, { visible: true, speed: 2 }, config)
    expect(next).toEqual({ clock: { minute: 481, remainderMs: 0 }, minutes: 1 })
  })

  it('a hidden tick keeps the remainder so the next visible tick completes the minute', () => {
    const half = tickClock(initialClock(config), 3000, visible1x, config).clock
    const hidden = tickClock(half, 3_600_000, { visible: false, speed: 2 }, config).clock
    expect(hidden).toBe(half)
    expect(tickClock(hidden, 3000, visible1x, config).clock).toEqual({
      minute: 481,
      remainderMs: 0,
    })
  })

  it('rejects a bad elapsed time even while hidden', () => {
    expect(() => tickClock(initialClock(config), -1, { visible: false, speed: 1 }, config)).toThrow(
      RangeError,
    )
    expect(() =>
      tickClock(initialClock(config), Number.NaN, { visible: false, speed: 1 }, config),
    ).toThrow(RangeError)
  })

  it('the shipped tick cap loses no time at the driver interval (1 s) at either speed', () => {
    expect(config.time.tickIntervalMs).toBeLessThan(config.time.maxTickRealMs)
    for (const speed of config.time.speeds) {
      expect(
        tickFor(initialClock(config), 10 * MINUTE_MS, config.time.tickIntervalMs, speed),
      ).toEqual({ minute: 480 + 100 * speed, remainderMs: 0 })
    }
  })

  it('caps a long gap at maxTickRealMs before the speed multiplier', () => {
    const { clock } = tickClock(
      initialClock(config),
      60 * MINUTE_MS,
      { visible: true, speed: 2 },
      config,
    )
    // 5000 ms x 2 = 10 000 scaled ms: one minute and 4000 ms carried.
    expect(clock).toEqual({ minute: 481, remainderMs: 4000 })
  })

  it('keeps the remainder in [0, one game minute) and never loses a whole minute over fuzzed ticks', () => {
    const random = seeded(20260308)
    let clock = initialClock(config)
    let scaledTotal = 0
    for (let i = 0; i < 50_000; i++) {
      const ms = random() * 1200
      const speed = random() < 0.5 ? 1 : 2
      clock = tickClock(clock, ms, { visible: true, speed }, config).clock
      scaledTotal += ms * speed
      expect(clock.remainderMs).toBeGreaterThanOrEqual(0)
      expect(clock.remainderMs).toBeLessThan(realMsPerGameMinute(config))
      expect(Number.isSafeInteger(clock.minute)).toBe(true)
    }
    const exact = scaledTotal / realMsPerGameMinute(config)
    // Float carry may sit a hair under a boundary; it must never drift by a whole minute.
    expect(Math.abs(clock.minute - 480 - exact)).toBeLessThan(1)
  })
})

describe('clock carry precision', () => {
  it.each([
    ['6,000,000 ticks of 0.1 ms', 6_000_000, 0.1],
    ['36,000 ticks of 50/3 ms', 36_000, 50 / 3],
  ])('%s at 2x land exactly on 200 game minutes', (_label, ticks, ms) => {
    let clock = { minute: 0, remainderMs: 0 }
    for (let i = 0; i < ticks; i++) {
      clock = tickClock(clock, ms, { visible: true, speed: 2 }, config).clock
    }
    expect(clock.minute).toBe(200)
  })

  it('carries the remainder in whole microseconds', () => {
    const { clock } = tickClock(initialClock(config), 0.1234, visible1x, config)
    expect(clock.remainderMs).toBe(0.123)
  })
})
