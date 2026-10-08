/**
 * The one grant function (S15). Every reward the game hands out (goal rewards now; referral
 * rewards and operator compensation later) goes through `grant`, which is:
 *
 * - **Idempotent.** The engine builds the grant key from what is granted (`goal:<id>:r<run>`);
 *   callers never pass one in. Asking again replays the original record and changes nothing.
 * - **Audited.** Every grant appends one record to `grants.log`: what was asked for, the cap,
 *   what was applied, the eligibility rule it passed, the personal-clock minute and the real
 *   time it was issued (injected by the caller), and `sync: 'local'`. Without a session grants
 *   are local only; S18c re-validates each record (`toServerGrantRow`) once a session exists,
 *   and the device then marks it `synced` (`markGrantsSynced`).
 * - **Eligibility-targeted.** A goal reward needs the goal reached this run, available (not
 *   coming soon), unclaimed, and no event open.
 * - **Capped** relative to the next progression goal (ECON-1), from config: clout at most
 *   `capPctOfGap.clout` percent of the clout still needed for the next level (0 at the top),
 *   cash at most `capPctOfGap.cash` percent of what the player still needs to move to the next
 *   home up (its rent reserve plus move-in cost; 0 in the top home), and each at most
 *   `maxPerGrant`. With a percentage below 100 a grant never closes a gap by itself, so grants
 *   alone never change the player's level. Granted clout is recorded as the `grant` source,
 *   which goal progress subtracts (src/engine/goals.ts `goalClout`).
 *
 * `previewGrant` runs the same evaluation as `grant`, so what the Claim button promises is what
 * lands (GR-11). Only this module writes `grant` clout (grants.guard.test.ts).
 */
import { playerLevel, recordClout, totalClout, type LevelUp } from './clout'
import type { EngineConfig, GoalDef, HomeId } from './config'
import type { EventsState } from './events'
import type { GameSnapshot } from './game'
import type { GoalsState } from './goals'
import { moveInCost, rentReserve } from './housing'
import type { PrestigeState } from './prestige'
import { homeIds, rentFor } from './rent'

/** What a grant gives: whole dollars, whole clout points and an optional badge id. */
export interface GrantAmounts {
  readonly cash: number
  readonly clout: number
  readonly badge: string | null
}

/** The most cash and clout a grant may apply right now. */
export interface GrantCaps {
  readonly cash: number
  readonly clout: number
}

export type GrantKind = 'goal_reward'

/** One audited grant. */
export interface GrantRecord {
  /** Increases by one per record, never reused. */
  readonly seq: number
  /** The idempotency key the engine built (`goal:<id>:r<run>`). */
  readonly key: string
  readonly kind: GrantKind
  /** The rule the grant passed, and what it was checked against. */
  readonly eligibility: {
    readonly rule: 'goal-achieved'
    readonly goalId: string
    readonly run: number
  }
  /** Why it was granted, for the audit trail (never shown to players). */
  readonly reason: string
  readonly requested: GrantAmounts
  readonly cap: GrantCaps
  readonly applied: GrantAmounts
  /** Personal-clock minute it was granted. */
  readonly at: number
  /** Real time it was issued (ms since the epoch), injected by the caller. */
  readonly issuedAtMs: number
  readonly issuedBy: 'system'
  readonly campaignId: null
  /**
   * `local` until the server accepts it (S18c), then `synced`. Device bookkeeping only: the
   * server's checks ignore it.
   */
  readonly sync: 'local' | 'synced'
}

export interface GrantsState {
  /** Newest last, at most `grants.log.maxEntries` (oldest dropped first). */
  readonly log: readonly GrantRecord[]
  /** The `seq` the next record gets. */
  readonly nextSeq: number
}

export const initialGrantsState: GrantsState = { log: [], nextSeq: 1 }

/** What a grant reads and writes: the save without its speed. */
export interface GrantSnapshot extends GameSnapshot {
  readonly goals: GoalsState
  readonly grants: GrantsState
  readonly prestige: PrestigeState
  readonly events: Pick<EventsState, 'active'>
}

/** The goal's reward exactly as configured (a caller cannot ask for more). */
export interface GoalReward {
  readonly cash?: number
  readonly clout?: number
  readonly badge?: true
}

export interface GoalRewardRequest {
  readonly kind: 'goal_reward'
  readonly goalId: string
  readonly reward: GoalReward
}

export interface GrantEligibilityError {
  readonly code: 'INELIGIBLE'
  readonly reason:
    'unknown-goal' | 'coming-soon' | 'not-achieved' | 'event-open' | 'already-claimed'
}

export type GrantError = GrantEligibilityError | { readonly code: 'INVALID_REWARD' }

export type GrantResult<S extends GrantSnapshot> =
  | {
      readonly ok: true
      readonly save: S
      /** The record written, or the original one on a replay. */
      readonly record: GrantRecord
      /** True when the key was already granted: nothing changed. */
      readonly replayed: boolean
      /** Never set for a capped grant; kept so callers handle every clout change alike. */
      readonly levelUp: LevelUp | null
    }
  | { readonly ok: false; readonly error: GrantError }

const GOAL_KEY = /^goal:([a-z0-9]+(?:-[a-z0-9]+)*):r([1-9]\d*)$/

/** The idempotency key of a goal's reward in a run. */
export function goalGrantKey(goalId: string, run: number): string {
  return `goal:${goalId}:r${run}`
}

/** The goal id and run a goal grant key names, or null for anything else. */
export function parseGoalGrantKey(
  key: string,
): { readonly goalId: string; readonly run: number } | null {
  const match = GOAL_KEY.exec(key)
  if (match === null) return null
  const run = Number(match[2])
  return Number.isSafeInteger(run) ? { goalId: match[1] ?? '', run } : null
}

/**
 * Every grant key this save has claimed: the log's keys and the clout ledger's grant
 * references (a record the log has dropped still blocks a second claim while its entry is kept).
 */
export function claimedGrantKeys(save: Pick<GrantSnapshot, 'grants' | 'player'>): Set<string> {
  const keys = new Set(save.grants.log.map((record) => record.key))
  for (const entry of save.player.clout.ledger) {
    if (entry.source === 'grant') keys.add(entry.ref.grantKey)
  }
  return keys
}

/** The badge a run earns: `prestige.badgeIds` in order, the last one again past the end. */
export function prestigeBadge(run: number, config: EngineConfig): string {
  const { badgeIds } = config.prestige
  const badge = badgeIds[Math.min(run, badgeIds.length) - 1]
  if (badge === undefined) throw new Error('config/progression.json has no prestige badge')
  return badge
}

/**
 * What a goal pays in `run` before the cap. With `prestige.rewardsRepeat` off, cash and clout
 * are paid in the first run only; the badge is always paid (each run earns its own).
 */
export function goalReward(goal: GoalDef, run: number, config: EngineConfig): GrantAmounts {
  const pays = run === 1 || config.prestige.rewardsRepeat
  return {
    cash: pays ? (goal.reward.cash ?? 0) : 0,
    clout: pays ? (goal.reward.clout ?? 0) : 0,
    badge: goal.reward.badge === true ? prestigeBadge(run, config) : null,
  }
}

/** The lowest-rent home above the player's current rent (ties: config order), or null. */
function nextHome(home: HomeId, config: EngineConfig): HomeId | null {
  const current = rentFor(home, config)
  let best: HomeId | null = null
  for (const id of homeIds(config)) {
    const rent = rentFor(id, config)
    if (rent > current && (best === null || rent < rentFor(best, config))) best = id
  }
  return best
}

/** The caps relative to the player's next progression goals (see the module comment). */
export function grantCaps(snapshot: GameSnapshot, config: EngineConfig): GrantCaps {
  const { player } = snapshot
  const { capPctOfGap, maxPerGrant } = config.grants
  const total = totalClout(player, config)
  const next = config.clout.levels[playerLevel(player, config).index + 1]
  const clout =
    next === undefined
      ? 0
      : Math.min(maxPerGrant.clout, Math.floor((capPctOfGap.clout * (next.minClout - total)) / 100))
  const home = nextHome(player.home, config)
  const cashGap =
    home === null
      ? 0
      : Math.max(0, rentReserve(player, config) + moveInCost(home, config) - player.cash)
  const cash = Math.min(maxPerGrant.cash, Math.floor((capPctOfGap.cash * cashGap) / 100))
  return { cash: Math.max(0, cash), clout: Math.max(0, clout) }
}

function sameReward(asked: GoalReward, goal: GoalDef): boolean {
  return (
    asked.cash === goal.reward.cash &&
    asked.clout === goal.reward.clout &&
    asked.badge === goal.reward.badge
  )
}

type Evaluation =
  | {
      readonly ok: true
      readonly goal: GoalDef
      readonly key: string
      readonly requested: GrantAmounts
      readonly cap: GrantCaps
      readonly applied: GrantAmounts
    }
  | { readonly ok: false; readonly requested: GrantAmounts; readonly error: GrantError }

const NOTHING: GrantAmounts = { cash: 0, clout: 0, badge: null }

/** The eligibility checks and the cap, shared by `previewGrant` and `grant`. */
function evaluate(save: GrantSnapshot, goalId: string, config: EngineConfig): Evaluation {
  const goal = config.goals.find((entry) => entry.id === goalId)
  if (goal === undefined) {
    return { ok: false, requested: NOTHING, error: { code: 'INELIGIBLE', reason: 'unknown-goal' } }
  }
  const { run } = save.goals
  const requested = goalReward(goal, run, config)
  const refuse = (reason: GrantEligibilityError['reason']): Evaluation => ({
    ok: false,
    requested,
    error: { code: 'INELIGIBLE', reason },
  })
  if (goal.available === false) return refuse('coming-soon')
  const key = goalGrantKey(goal.id, run)
  if (claimedGrantKeys(save).has(key)) return refuse('already-claimed')
  if (!Object.hasOwn(save.goals.achieved, goal.id)) return refuse('not-achieved')
  if (save.events.active !== null) return refuse('event-open')
  const cap = grantCaps(save, config)
  const applied = {
    cash: Math.min(requested.cash, cap.cash),
    clout: Math.min(requested.clout, cap.clout),
    badge: requested.badge,
  }
  return { ok: true, goal, key, requested, cap, applied }
}

export type GrantPreview =
  | {
      readonly ok: true
      readonly requested: GrantAmounts
      readonly cap: GrantCaps
      readonly applied: GrantAmounts
    }
  | { readonly ok: false; readonly requested: GrantAmounts; readonly error: GrantError }

/** What claiming the goal's reward right now would apply, by the rules `grant` uses. */
export function previewGrant(
  save: GrantSnapshot,
  goalId: string,
  config: EngineConfig,
): GrantPreview {
  const result = evaluate(save, goalId, config)
  if (!result.ok) return result
  return { ok: true, requested: result.requested, cap: result.cap, applied: result.applied }
}

function addBadge(prestige: PrestigeState, badge: string | null): PrestigeState {
  if (badge === null || prestige.badges.includes(badge)) return prestige
  return { ...prestige, badges: [...prestige.badges, badge] }
}

/**
 * Grants a goal's reward (see the module comment). `request.reward` must be the goal's
 * configured reward exactly. `issuedAtMs` is the real time of the request (the store passes
 * `Date.now()`; the engine never reads the clock).
 */
export function grant<S extends GrantSnapshot>(
  save: S,
  request: GoalRewardRequest,
  issuedAtMs: number,
  config: EngineConfig,
): GrantResult<S> {
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) {
    throw new RangeError(`issuedAtMs must be a whole, non-negative number: ${issuedAtMs}`)
  }
  const goal = config.goals.find((entry) => entry.id === request.goalId)
  if (goal === undefined)
    return { ok: false, error: { code: 'INELIGIBLE', reason: 'unknown-goal' } }
  if (request.kind !== 'goal_reward' || !sameReward(request.reward, goal)) {
    return { ok: false, error: { code: 'INVALID_REWARD' } }
  }
  const key = goalGrantKey(goal.id, save.goals.run)
  const original = save.grants.log.find((record) => record.key === key)
  if (original !== undefined) {
    return { ok: true, save, record: original, replayed: true, levelUp: null }
  }

  const result = evaluate(save, goal.id, config)
  if (!result.ok) return { ok: false, error: result.error }
  const { applied } = result
  let snapshot: GameSnapshot = {
    clock: save.clock,
    player: { ...save.player, cash: save.player.cash + applied.cash },
  }
  let levelUp: LevelUp | null = null
  if (applied.clout > 0) {
    const recorded = recordClout(
      snapshot,
      { source: 'grant', amount: applied.clout, ref: { grantKey: key } },
      config,
    )
    snapshot = { ...snapshot, player: recorded.player }
    levelUp = recorded.levelUp
  }

  const record: GrantRecord = {
    seq: save.grants.nextSeq,
    key,
    kind: 'goal_reward',
    eligibility: { rule: 'goal-achieved', goalId: goal.id, run: save.goals.run },
    reason: `Goal reward: ${goal.id}`,
    requested: result.requested,
    cap: result.cap,
    applied,
    at: save.clock.minute,
    issuedAtMs,
    issuedBy: 'system',
    campaignId: null,
    sync: 'local',
  }
  const log = [...save.grants.log, record].slice(-config.grants.log.maxEntries)
  return {
    ok: true,
    save: {
      ...save,
      player: snapshot.player,
      grants: { log, nextSeq: save.grants.nextSeq + 1 },
      prestige: addBadge(save.prestige, applied.badge),
    },
    record,
    replayed: false,
    levelUp,
  }
}

/**
 * Marks the records the server holds (`keys`) as `synced`. Pure; records already synced, or not
 * named, are left as they are, and an unchanged log returns the same state.
 */
export function markGrantsSynced(grants: GrantsState, keys: Iterable<string>): GrantsState {
  const held = new Set(keys)
  if (!grants.log.some((record) => record.sync === 'local' && held.has(record.key))) return grants
  return {
    ...grants,
    log: grants.log.map((record) =>
      record.sync === 'local' && held.has(record.key) ? { ...record, sync: 'synced' } : record,
    ),
  }
}

/** A JSON value (the `eligibility` column is jsonb). */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * A row of the S18 `grants` table (supabase/migrations/*_s18_saves_money.sql), column for
 * column. Declared here because the engine has no Supabase imports; a type test checks it
 * against the generated table types.
 */
export interface ServerGrantRow {
  readonly user_id: string
  readonly kind: GrantKind
  readonly idempotency_key: string
  readonly cash_amount: number
  readonly clout_amount: number
  readonly item_id: string | null
  /** The cash cap. */
  readonly cap_amount: number
  /** The clout cap (SEC-8: the table checks clout_amount <= clout_cap). */
  readonly clout_cap: number
  readonly eligibility: { readonly [key: string]: JsonValue }
  readonly reason: string
  readonly issued_by: 'system'
  readonly campaign_id: null
}

/**
 * The server row S18c inserts when it re-validates a local grant. SEC-8: the key is the engine's
 * own (`goal:<id>:r<run>`), unique per user (`unique(user_id, idempotency_key)`), and the clout
 * cap has its own column. `applied_at` is left for the server to set when it accepts the grant.
 */
export function toServerGrantRow(record: GrantRecord, userId: string): ServerGrantRow {
  return {
    user_id: userId,
    kind: record.kind,
    idempotency_key: record.key,
    cash_amount: record.applied.cash,
    clout_amount: record.applied.clout,
    item_id: record.applied.badge,
    cap_amount: record.cap.cash,
    clout_cap: record.cap.clout,
    eligibility: {
      rule: record.eligibility.rule,
      goalId: record.eligibility.goalId,
      run: record.eligibility.run,
      requested: {
        cash: record.requested.cash,
        clout: record.requested.clout,
        badge: record.requested.badge,
      },
      localSeq: record.seq,
      at: record.at,
      issuedAtMs: record.issuedAtMs,
    },
    reason: record.reason,
    issued_by: record.issuedBy,
    campaign_id: record.campaignId,
  }
}

export interface GrantCeilings {
  /** The most one grant can apply. */
  readonly perGrant: GrantCaps
  /** The most every goal of one run can apply together. */
  readonly perRun: GrantCaps
}

/**
 * What grants can add at most, from config alone, for S18c's save plausibility: per grant the
 * largest configured reward within `maxPerGrant`, per run the sum of every available goal's.
 */
export function grantCeilings(config: EngineConfig): GrantCeilings {
  const { maxPerGrant } = config.grants
  const rewards = config.goals
    .filter((goal) => goal.available !== false)
    .map((goal) => ({
      cash: Math.min(maxPerGrant.cash, goal.reward.cash ?? 0),
      clout: Math.min(maxPerGrant.clout, goal.reward.clout ?? 0),
    }))
  return {
    perGrant: {
      cash: Math.max(0, ...rewards.map((reward) => reward.cash)),
      clout: Math.max(0, ...rewards.map((reward) => reward.clout)),
    },
    perRun: {
      cash: rewards.reduce((sum, reward) => sum + reward.cash, 0),
      clout: rewards.reduce((sum, reward) => sum + reward.clout, 0),
    },
  }
}
