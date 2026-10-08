import { describe, expect, it } from 'vitest'
import { cityTime } from './cityTime'
import { initialClock, tickClock } from './clock'
import { engineConfig } from './config'

const at = (iso: string) => Date.parse(iso)
const hms = (epochMs: number) => {
  const { hour, minute, second } = cityTime(epochMs)
  return [hour, minute, second]
}

describe('city time (real New York wall clock)', () => {
  it('reads New York time from an injected instant', () => {
    expect(cityTime(at('2026-07-04T16:30:15Z'))).toEqual({
      year: 2026,
      month: 7,
      day: 4,
      hour: 12,
      minute: 30,
      second: 15,
      weekday: 6,
      utcOffsetMinutes: -240,
      dateKey: '2026-07-04',
    })
  })

  it('uses 0-23 hours and the New York date around midnight', () => {
    const justAfterMidnight = cityTime(at('2026-01-15T05:00:30Z'))
    expect(justAfterMidnight).toMatchObject({ hour: 0, minute: 0, day: 15, dateKey: '2026-01-15' })
    expect(cityTime(at('2026-01-15T04:59:59Z')).dateKey).toBe('2026-01-14')
  })

  it('springs forward on 2026-03-08: 01:59:59 EST is followed by 03:00:00 EDT', () => {
    const before = at('2026-03-08T06:59:59Z')
    expect(hms(before)).toEqual([1, 59, 59])
    expect(cityTime(before).utcOffsetMinutes).toBe(-300)
    expect(hms(before + 1000)).toEqual([3, 0, 0])
    expect(cityTime(before + 1000).utcOffsetMinutes).toBe(-240)
    expect(cityTime(before + 1000).dateKey).toBe('2026-03-08')
  })

  it('falls back on 2026-11-01: 01:30 happens twice, first EDT then EST', () => {
    const firstPass = at('2026-11-01T05:30:00Z')
    const secondPass = at('2026-11-01T06:30:00Z')
    expect(hms(firstPass)).toEqual([1, 30, 0])
    expect(hms(secondPass)).toEqual([1, 30, 0])
    expect(cityTime(firstPass).utcOffsetMinutes).toBe(-240)
    expect(cityTime(secondPass).utcOffsetMinutes).toBe(-300)
    expect(hms(at('2026-11-01T05:59:59Z'))).toEqual([1, 59, 59])
    expect(hms(at('2026-11-01T06:00:00Z'))).toEqual([1, 0, 0])
  })

  it('a New York day is 23 or 25 real hours across a DST change', () => {
    const midnight = (iso: string) => at(iso)
    expect(cityTime(midnight('2026-03-09T03:59:59Z')).dateKey).toBe('2026-03-08')
    expect(cityTime(midnight('2026-03-09T04:00:00Z')).dateKey).toBe('2026-03-09')
    expect(cityTime(midnight('2026-11-02T04:59:59Z')).dateKey).toBe('2026-11-01')
    expect(cityTime(midnight('2026-11-02T05:00:00Z')).dateKey).toBe('2026-11-02')
  })

  it('is independent of the personal game clock', () => {
    // The DST jump moves city time by an hour; the personal clock only counts played time.
    const before = at('2026-03-08T06:59:59Z')
    const clock = tickClock(
      initialClock(engineConfig),
      1000,
      { visible: true, speed: 1 },
      engineConfig,
    )
    expect(clock.clock.remainderMs).toBe(1000)
    expect(clock.minutes).toBe(0)
    expect(cityTime(before + 1000).hour - cityTime(before).hour).toBe(2)
  })

  it('rejects a non-finite instant', () => {
    expect(() => cityTime(Number.NaN)).toThrow(RangeError)
  })

  it('both DST change days are Sundays with the full field set', () => {
    expect(cityTime(at('2026-03-08T07:00:00Z'))).toEqual({
      year: 2026,
      month: 3,
      day: 8,
      hour: 3,
      minute: 0,
      second: 0,
      weekday: 0,
      utcOffsetMinutes: -240,
      dateKey: '2026-03-08',
    })
    expect(cityTime(at('2026-11-01T06:30:00.999Z'))).toMatchObject({
      hour: 1,
      minute: 30,
      second: 0,
      weekday: 0,
      utcOffsetMinutes: -300,
    })
  })

  it('handles instants before the epoch', () => {
    expect(cityTime(at('1969-12-31T23:59:59.500Z'))).toMatchObject({
      dateKey: '1969-12-31',
      hour: 18,
      minute: 59,
      second: 59,
      utcOffsetMinutes: -300,
    })
  })
})
