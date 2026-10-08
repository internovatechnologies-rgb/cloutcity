import { describe, expect, it } from 'vitest'
import onboardingJson from '@data/config/onboarding.json'
import {
  birthYearOptions,
  currentCityYear,
  deriveGateStatus,
  isAdultBirthYear,
  isLocked,
  lockUntil,
} from './ageGate'

const config = onboardingJson
const at = (iso: string) => Date.parse(iso)
// Midday in New York, well clear of any year boundary.
const NOW_2026 = at('2026-06-15T16:00:00Z')

describe('isAdultBirthYear', () => {
  it('passes Y-19 and earlier, refuses Y-18 and later (birthday unknown)', () => {
    expect(isAdultBirthYear(2007, NOW_2026, config)).toBe(true)
    expect(isAdultBirthYear(1926, NOW_2026, config)).toBe(true)
    expect(isAdultBirthYear(2008, NOW_2026, config)).toBe(false)
    expect(isAdultBirthYear(2009, NOW_2026, config)).toBe(false)
    expect(isAdultBirthYear(2026, NOW_2026, config)).toBe(false)
  })

  it('uses the New York year, not UTC', () => {
    // 03:00 UTC on 1 January 2027 is still 22:00 on 31 December 2026 in New York.
    const nyNewYearsEve = at('2027-01-01T03:00:00Z')
    expect(currentCityYear(nyNewYearsEve)).toBe(2026)
    expect(isAdultBirthYear(2008, nyNewYearsEve, config)).toBe(false)
    expect(isAdultBirthYear(2007, nyNewYearsEve, config)).toBe(true)
    // Once New York reaches 2027, 2008 passes.
    expect(isAdultBirthYear(2008, at('2027-01-01T05:00:00Z'), config)).toBe(true)
  })

  it('rejects a non-integer year', () => {
    expect(isAdultBirthYear(1990.5, NOW_2026, config)).toBe(false)
    expect(isAdultBirthYear(Number.NaN, NOW_2026, config)).toBe(false)
    expect(isAdultBirthYear(Number.NEGATIVE_INFINITY, NOW_2026, config)).toBe(false)
  })

  it('follows minimumAge from config', () => {
    const older = { ...config, minimumAge: 21 }
    expect(isAdultBirthYear(2005, NOW_2026, older)).toBe(false)
    expect(isAdultBirthYear(2004, NOW_2026, older)).toBe(true)
  })
})

describe('birthYearOptions', () => {
  it('lists span + 1 years, newest first, starting at the current year', () => {
    const options = birthYearOptions(2026, config.birthYearSpan)
    expect(options).toHaveLength(config.birthYearSpan + 1)
    expect(options[0]).toBe(2026)
    expect(options.at(-1)).toBe(2026 - config.birthYearSpan)
    expect(options.every((year, i) => i === 0 || year === (options[i - 1] ?? 0) - 1)).toBe(true)
  })
})

describe('under-age lock', () => {
  const t0 = NOW_2026

  it('lasts underAgeLockHours and ends exactly at lockedUntil', () => {
    const until = lockUntil(t0, config)
    expect(until).toBe(t0 + 24 * 3_600_000)
    expect(isLocked(until, t0)).toBe(true)
    expect(isLocked(until, until - 1)).toBe(true)
    expect(isLocked(until, until)).toBe(false)
    expect(isLocked(until, until + 60_000)).toBe(false)
  })

  it('stays locked when the clock is set back', () => {
    expect(isLocked(lockUntil(t0, config), t0 - 86_400_000)).toBe(true)
  })
})

describe('deriveGateStatus', () => {
  const t0 = NOW_2026
  const lockedUntil = lockUntil(t0, config)

  it('is pending until storage is read, then shows the card when nothing is stored', () => {
    expect(deriveGateStatus(undefined, t0)).toBe('pending')
    expect(deriveGateStatus(null, t0)).toBe('welcome')
  })

  it('shows nothing once onboarding is complete', () => {
    expect(deriveGateStatus({ status: 'complete' }, t0)).toBe('done')
  })

  it('shows the lock screen until the lock ends, then the card again', () => {
    expect(deriveGateStatus({ status: 'locked', lockedUntil }, t0)).toBe('locked')
    expect(deriveGateStatus({ status: 'locked', lockedUntil }, lockedUntil - 1)).toBe('locked')
    expect(deriveGateStatus({ status: 'locked', lockedUntil }, lockedUntil)).toBe('welcome')
  })
})
