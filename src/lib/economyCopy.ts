/**
 * Player-facing text for jobs, housing and rent, built from engine data through the copy layer
 * and the shared formatters. Rent comparisons are computed from `rentPerWeek`, never written
 * as literals (GR-11): the rank word comes from `superlative()`.
 *
 * Client code: it reads data/jobs/jobs.json directly (validated in src/lib/data/data.test.ts)
 * rather than through the classic-zod loader in src/lib/data/content.ts.
 */
import jobsJson from '@data/jobs/jobs.json'
import { engineConfig, type EngineConfig, type HomeId, type JobId } from '@/engine/config'
import { shiftWage, type JobLock } from '@/engine/jobs'
import { homeIds, rentFor, type RentEvent } from '@/engine/rent'
import { copy as activeCopy, isCopyKey, superlative, type CopyFn, type CopyKey } from './copy'
import { formatCount, formatMoney } from './format'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/clout'
import '@/lib/copy/ns/housing'
import '@/lib/copy/ns/jobs'
import '@/lib/copy/ns/rent'

function requireKey(key: string, what: string): CopyKey {
  if (!isCopyKey(key)) throw new Error(`No copy key "${key}" for ${what}`)
  return key
}

/** `scene-regular` → `sceneRegular`, the copy-key segment for a kebab-case id. */
function camelSegment(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, next: string) => next.toUpperCase())
}

export interface EconomyCopyOptions {
  readonly copy?: CopyFn
  readonly config?: EngineConfig
}

export function jobName(jobId: JobId, { copy = activeCopy }: EconomyCopyOptions = {}): string {
  const job = jobsJson.jobs.find((entry) => entry.id === jobId)
  if (job === undefined) throw new Error(`data/jobs/jobs.json has no job "${jobId}"`)
  return copy(requireKey(job.nameKey, `job ${jobId}`))
}

export function cloutLevelName(levelId: string, { copy = activeCopy }: EconomyCopyOptions = {}) {
  return copy(requireKey(`clout.levels.${camelSegment(levelId)}.name`, `clout level ${levelId}`))
}

export function homeName(homeId: HomeId, { copy = activeCopy }: EconomyCopyOptions = {}): string {
  return copy(requireKey(`housing.${camelSegment(homeId)}.name`, `home ${homeId}`))
}

/** Label for a work-shift control, e.g. "Work a Barista shift: 4 hours for $56". */
export function shiftLabel(jobId: JobId, options: EconomyCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  return copy('jobs.shift.label', {
    job: jobName(jobId, options),
    hours: formatCount(config.jobs.shiftHours),
    pay: formatMoney(shiftWage(jobId, config)),
  })
}

export function shiftDone(wage: number, { copy = activeCopy }: EconomyCopyOptions = {}): string {
  return copy('jobs.shift.done', { pay: formatMoney(wage) })
}

/**
 * Why a job is locked, in voice. It names the job and the level needed, so it also serves as
 * the accessible name of the locked control (CLAUDE.md "Accessibility").
 */
export function jobLockedLabel(lock: JobLock, options: EconomyCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('jobs.locked.label', {
    job: jobName(lock.jobId, options),
    level: cloutLevelName(lock.requiredLevel, options),
    current: cloutLevelName(lock.currentLevel, options),
  })
}

function rents(config: EngineConfig) {
  return homeIds(config).map((id) => ({ id, value: rentFor(id, config) }))
}

/** A home's weekly rent, with its rank only when the data proves it ("the cheapest ..."). */
export function homeRentLine(homeId: HomeId, options: EconomyCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  const vars = { home: homeName(homeId, options), rent: formatMoney(rentFor(homeId, config)) }
  const rank = superlative('cheapest', homeId, rents(config))
  return rank === null
    ? copy('housing.rent.perWeek', vars)
    : copy('housing.rent.ranked', { ...vars, rank })
}

/** Compares two homes' weekly rents, with the difference computed from config. */
export function homeRentComparison(
  homeId: HomeId,
  otherId: HomeId,
  options: EconomyCopyOptions = {},
): string {
  const { copy = activeCopy, config = engineConfig } = options
  const difference = rentFor(homeId, config) - rentFor(otherId, config)
  const vars = { home: homeName(homeId, options), other: homeName(otherId, options) }
  if (difference === 0) return copy('housing.rent.sameAs', vars)
  const key = difference > 0 ? 'housing.rent.moreThan' : 'housing.rent.lessThan'
  return copy(key, { ...vars, difference: formatMoney(Math.abs(difference)) })
}

export function nextRentDueLine(
  homeId: HomeId,
  day: number,
  options: EconomyCopyOptions = {},
): string {
  const { copy = activeCopy, config = engineConfig } = options
  return copy('rent.nextDue', {
    rent: formatMoney(rentFor(homeId, config)),
    day: formatCount(day),
  })
}

/** The notice for one rent event from the engine. */
export function rentNotice(event: RentEvent, options: EconomyCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  switch (event.kind) {
    case 'paid':
      return event.arrears > 0
        ? copy('rent.paidWithArrears', {
            rent: formatMoney(event.rent),
            arrears: formatMoney(event.arrears),
          })
        : copy('rent.paid', { rent: formatMoney(event.rent) })
    case 'arrears-paid':
      return copy('rent.arrearsPaid', { amount: formatMoney(event.amount) })
    case 'missed': {
      const vars = { owed: formatMoney(event.owed), left: formatCount(event.missesBeforeEviction) }
      return event.lateFee > 0
        ? copy('rent.missedWithFee', { ...vars, fee: formatMoney(event.lateFee) })
        : copy('rent.missed', vars)
    }
    case 'evicted':
      return copy('rent.evicted', {
        home: homeName(event.to, options),
        rent: formatMoney(rentFor(event.to, config)),
      })
  }
}

/** "You live in the Queens room." */
export function homeLine(homeId: HomeId, options: EconomyCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('rent.home', { home: homeName(homeId, options) })
}

/** What the player owes in back rent and fees right now, or that they owe nothing. */
export function rentOwedLine(owed: number, { copy = activeCopy }: EconomyCopyOptions = {}) {
  return owed > 0 ? copy('rent.owed', { owed: formatMoney(owed) }) : copy('rent.square')
}
