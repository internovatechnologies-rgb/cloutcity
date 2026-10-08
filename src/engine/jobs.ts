/**
 * Jobs: a shift is an action built from data/config/balance.json `jobs`. It lasts
 * `shiftHours` (fast-forwarding the personal clock, with the at-zero slowdown applied like any
 * action), costs the job's `energyCostPerShift` up front and pays `hourlyWage * shiftHours`
 * when it ends. The pay is per shift, so a slowed shift pays the same. Rent that falls due
 * during a shift is charged before the shift's pay lands.
 *
 * A job listed in `jobs.requiredCloutLevel` is locked until the player reaches that level.
 *
 * The first shift a player ever completes also pays `clout.sources.firstPaycheck` clout
 * (once per player, recorded in the clout ledger as a `paycheck` entry).
 */
import { applyAction, type ActionDef, type ActionError, type ActionResult } from './actions'
import { findCloutLevel, playerLevel, recordClout, type LevelUp } from './clout'
import type { EngineConfig, JobId } from './config'
import type { GameSnapshot, PlayerState } from './game'

const MINUTES_PER_HOUR = 60

export function isJobId(id: unknown, config: EngineConfig): id is JobId {
  return typeof id === 'string' && Object.hasOwn(config.jobs.hourlyWage, id)
}

export function jobIds(config: EngineConfig): JobId[] {
  return Object.keys(config.jobs.hourlyWage).filter((id) => isJobId(id, config))
}

/** Whole dollars one shift pays. */
export function shiftWage(jobId: JobId, config: EngineConfig): number {
  return config.jobs.hourlyWage[jobId] * config.jobs.shiftHours
}

/** One shift as an action (validated by `applyAction` like any other). */
export function shiftAction(jobId: JobId, config: EngineConfig): ActionDef {
  return {
    durationMin: config.jobs.shiftHours * MINUTES_PER_HOUR,
    cashCost: 0,
    energyCost: config.jobs.energyCostPerShift[jobId],
    statEffects: {},
  }
}

export interface JobLock {
  readonly jobId: JobId
  /** The `clout.levels` id the job needs. */
  readonly requiredLevel: string
  /** The player's current level id. */
  readonly currentLevel: string
}

/** Why `jobId` is locked for this player, or null when they can work it. */
export function jobLock(player: PlayerState, jobId: JobId, config: EngineConfig): JobLock | null {
  const requiredId = config.jobs.requiredCloutLevel[jobId]
  if (requiredId === undefined) return null
  const required = findCloutLevel(requiredId, config)
  if (required === undefined) {
    throw new Error(`jobs.requiredCloutLevel.${jobId}: unknown clout level "${requiredId}"`)
  }
  const current = playerLevel(player, config)
  if (current.index >= required.index) return null
  return { jobId, requiredLevel: required.id, currentLevel: current.id }
}

export type ShiftError =
  | ActionError
  | { readonly code: 'UNKNOWN_JOB'; readonly jobId: string }
  | ({ readonly code: 'JOB_LOCKED' } & JobLock)

export type ShiftResult =
  | (Extract<ActionResult, { ok: true }> & {
      /** Whole dollars credited when the shift ended. */
      readonly wage: number
      /** Clout the shift earned: the first paycheck's, otherwise 0. */
      readonly cloutGained: number
      readonly levelUp: LevelUp | null
    })
  | { readonly ok: false; readonly error: ShiftError }

/** Works one shift of `jobId`: the clock fast-forwards, energy is paid, the wage lands. */
export function workShift(
  snapshot: GameSnapshot,
  jobId: string,
  config: EngineConfig,
): ShiftResult {
  if (!isJobId(jobId, config)) return { ok: false, error: { code: 'UNKNOWN_JOB', jobId } }
  const lock = jobLock(snapshot.player, jobId, config)
  if (lock !== null) return { ok: false, error: { code: 'JOB_LOCKED', ...lock } }

  const result = applyAction(snapshot, shiftAction(jobId, config), config)
  if (!result.ok) return result
  const wage = shiftWage(jobId, config)
  const { player } = result.snapshot
  const paid: GameSnapshot = {
    ...result.snapshot,
    player: { ...player, cash: player.cash + wage },
  }
  if (paid.player.clout.firstPaycheckPaid) {
    return { ...result, snapshot: paid, wage, cloutGained: 0, levelUp: null }
  }
  const record = recordClout(
    paid,
    { source: 'paycheck', amount: config.clout.sources.firstPaycheck, ref: { jobId } },
    config,
  )
  const clout = { ...record.player.clout, firstPaycheckPaid: true }
  return {
    ...result,
    snapshot: { ...paid, player: { ...record.player, clout } },
    wage,
    cloutGained: record.entry?.amount ?? 0,
    levelUp: record.levelUp,
  }
}
