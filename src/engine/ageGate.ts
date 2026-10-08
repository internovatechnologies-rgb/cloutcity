/**
 * The 18+ welcome-card rules (CLAUDE.md "Safety rules: Age"). Pure: the caller passes the
 * current instant in, and the year is New York city time, not the device's time zone.
 *
 * Only a birth *year* is asked, so a player born in `currentYear - minimumAge` may or may not
 * have had their birthday yet. The gate refuses that year: only a year at least
 * `minimumAge + 1` back is certain to be old enough.
 */
import type { OnboardingConfig } from '@/lib/data/schemas/config'
import { cityTime } from './cityTime'

export type AgeGateConfig = Pick<
  OnboardingConfig,
  'minimumAge' | 'underAgeLockHours' | 'birthYearSpan'
>

const MS_PER_HOUR = 3_600_000

/** The current year in New York at `nowMs`. */
export function currentCityYear(nowMs: number): number {
  return cityTime(nowMs).year
}

/** True only when every person born in `birthYear` is old enough at `nowMs`. */
export function isAdultBirthYear(birthYear: number, nowMs: number, config: AgeGateConfig): boolean {
  if (!Number.isInteger(birthYear)) return false
  return birthYear <= currentCityYear(nowMs) - (config.minimumAge + 1)
}

/**
 * The years the picker offers, newest first: from `currentYear` back `span` years. It starts at
 * the current year, not at the threshold, so the list itself gives no hint of the age rule.
 */
export function birthYearOptions(currentYear: number, span: number): number[] {
  return Array.from({ length: span + 1 }, (_, index) => currentYear - index)
}

/** When an under-age answer given at `nowMs` stops locking the gate. */
export function lockUntil(nowMs: number, config: AgeGateConfig): number {
  return nowMs + config.underAgeLockHours * MS_PER_HOUR
}

/**
 * Whether a lock still holds. Setting the device clock back keeps it locked (it can only end
 * once the clock reaches `lockedUntil`).
 */
export function isLocked(lockedUntil: number, nowMs: number): boolean {
  return nowMs < lockedUntil
}

/** The parts of a stored onboarding record the gate looks at. */
export type GateRecord =
  { readonly status: 'complete' } | { readonly status: 'locked'; readonly lockedUntil: number }

/**
 * What the welcome gate shows: `pending` until stored onboarding is known (the server render
 * and first hydration pass), the card, the under-age lock screen, or nothing (`done`).
 */
export type GateStatus = 'pending' | 'welcome' | 'locked' | 'done'

/** `record` is undefined until storage has been read, and null when nothing is stored. */
export function deriveGateStatus(record: GateRecord | null | undefined, nowMs: number): GateStatus {
  if (record === undefined) return 'pending'
  if (record === null) return 'welcome'
  if (record.status === 'complete') return 'done'
  return isLocked(record.lockedUntil, nowMs) ? 'locked' : 'welcome'
}
