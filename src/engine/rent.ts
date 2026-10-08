/**
 * Housing and rent. The player lives in one home (a key of `rentPerWeek`); rent for it is
 * charged at every rent-week boundary the personal clock crosses (the midnight that starts
 * game day 8, 15, 22, ...: every `time.rentPeriodGameDays` days).
 *
 * Missed rent escalates (`rent` in data/config/balance.json):
 * - On a due date the player pays what they owe plus the week's rent, in full, or nothing.
 * - Each consecutive due date missed adds the week's rent and `lateFees[missed - 1]` to what
 *   they owe (a fee of 0 is a warning). Any midnight before the next due date, the debt is
 *   collected in full if the player has the cash, which clears the misses.
 * - On the `evictAfterMissed`-th consecutive miss the player is evicted: they move to the
 *   lowest-rent home (computed from `rentPerWeek`) and the debt is written off. Decor in slots
 *   that home does not have goes back to storage (src/engine/home.ts `placementsAfterMove`).
 *
 * Like stat decay, the result depends only on the start and end minute of an advance, never on
 * how the time was split into ticks or actions, so a boundary is never charged twice.
 */
import { HOME_IDS, lowestRentHome } from '@/lib/data/homes'
import { minutesPerDay } from './clock'
import { isHomeId, type EngineConfig, type HomeId } from './config'
import type { PlayerState } from './game'
import { placementsAfterMove } from './home'

export interface RentState {
  /** Whole dollars of unpaid rent and late fees. */
  readonly owed: number
  /** Consecutive due dates not paid in full (0 when the player is square). */
  readonly missed: number
}

export type RentEvent =
  | {
      readonly kind: 'paid'
      /** 1-based game day the charge fell on. */
      readonly day: number
      readonly home: HomeId
      readonly rent: number
      /** Back rent and fees paid along with this week's rent. */
      readonly arrears: number
    }
  | { readonly kind: 'arrears-paid'; readonly day: number; readonly amount: number }
  | {
      readonly kind: 'missed'
      readonly day: number
      readonly home: HomeId
      readonly rent: number
      readonly lateFee: number
      /** Total owed after this miss. */
      readonly owed: number
      readonly missed: number
      /** Further misses in a row that end in eviction (at least 1). */
      readonly missesBeforeEviction: number
    }
  | {
      readonly kind: 'evicted'
      readonly day: number
      readonly from: HomeId
      readonly to: HomeId
      /** Debt written off on eviction. */
      readonly forgiven: number
    }

export const initialRent: RentState = { owed: 0, missed: 0 }

/** Every home, in HOME_IDS order (src/lib/data/homes.ts). */
export function homeIds(config: EngineConfig): HomeId[] {
  return HOME_IDS.filter((id) => isHomeId(id, config))
}

export function rentFor(home: HomeId, config: EngineConfig): number {
  return config.rentPerWeek[home]
}

/**
 * The home with the lowest weekly rent (on a tie, the first in HOME_IDS), by the same rule the
 * balance schema uses for `housing.moveInCost`.
 */
export function cheapestHome(config: EngineConfig): HomeId {
  return lowestRentHome(config.rentPerWeek)
}

/** The 1-based game day whose first minute is the next rent charge after `minute`. */
export function nextRentDueDay(minute: number, config: EngineConfig): number {
  const period = config.time.rentPeriodGameDays
  const dayIndex = Math.floor(minute / minutesPerDay(config))
  return (Math.floor(dayIndex / period) + 1) * period + 1
}

export interface RentSettlement {
  readonly player: PlayerState
  readonly events: readonly RentEvent[]
}

/**
 * Charges rent at each rent-week boundary and collects any debt at each midnight crossed
 * strictly after `fromMinute`, up to and including `toMinute`.
 */
export function settleRent(
  player: PlayerState,
  fromMinute: number,
  toMinute: number,
  config: EngineConfig,
): RentSettlement {
  const perDay = minutesPerDay(config)
  const period = config.time.rentPeriodGameDays
  const lastDay = Math.floor(toMinute / perDay)
  let { cash, home } = player
  let { owed, missed } = player.rent
  const events: RentEvent[] = []

  // `dayIndex` is 0-based: the midnight starting day index d is minute d * perDay.
  let dayIndex = Math.floor(fromMinute / perDay) + 1
  while (dayIndex <= lastDay) {
    const day = dayIndex + 1
    if (dayIndex % period === 0) {
      const rent = rentFor(home, config)
      const total = owed + rent
      if (cash >= total) {
        cash -= total
        events.push({ kind: 'paid', day, home, rent, arrears: owed })
        owed = 0
        missed = 0
      } else if (missed + 1 >= config.rent.evictAfterMissed) {
        const to = cheapestHome(config)
        events.push({ kind: 'evicted', day, from: home, to, forgiven: total })
        home = to
        owed = 0
        missed = 0
      } else {
        missed += 1
        const lateFee = config.rent.lateFees[missed - 1] ?? 0
        owed = total + lateFee
        const missesBeforeEviction = config.rent.evictAfterMissed - missed
        events.push({
          kind: 'missed',
          day,
          home,
          rent,
          lateFee,
          owed,
          missed,
          missesBeforeEviction,
        })
      }
      dayIndex += 1
    } else if (owed > 0) {
      if (cash >= owed) {
        cash -= owed
        events.push({ kind: 'arrears-paid', day, amount: owed })
        owed = 0
        missed = 0
      }
      dayIndex += 1
    } else {
      // Nothing is owed: skip straight to the next due date.
      dayIndex = Math.ceil(dayIndex / period) * period
    }
  }

  if (events.length === 0) return { player, events }
  const apartment =
    home === player.home
      ? player.apartment
      : { ...player.apartment, placed: placementsAfterMove(player.apartment.placed, home, config) }
  return { player: { ...player, cash, home, rent: { owed, missed }, apartment }, events }
}
