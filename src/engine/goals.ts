/**
 * Goals (S15): the "Make it in New York" checklist. Each goal (data/config/progression.json) is
 * a fact read from saved state: the first paycheck, the first outfit, the first landmark visit,
 * the first club night, the first friend (coming soon), and one goal per clout level.
 *
 * - `syncGoals` records each goal the moment its fact first holds, at the personal clock's
 *   minute. Achievements are sticky for the run: selling the outfit or dropping a level later
 *   does not take the goal back. It is idempotent, so the store runs it after every
 *   state-changing action (never on the passive tick).
 * - Level goals read **goal clout** (`goalClout`): earned clout minus granted clout, plus item
 *   and home clout, never premium. Granted value never counts toward goal progress (ECON-1), so no reward,
 *   compensation or promo can carry a player to the next goal. The HUD and every gate (borough,
 *   job, club door) still read the total (src/engine/clout.ts `totalClout`).
 * - A goal's reward is claimed by hand through the one grant function (src/engine/grants.ts),
 *   keyed `goal:<id>:r<run>`; `goalsView` previews exactly what a claim would pay (GR-11).
 * - Reaching the victory goal (Icon) starts the Icon moment: `goals.icon.reachedAt` is set and
 *   stays unacknowledged until the player closes the victory screen or prestiges.
 */
import { findCloutLevel, goalClout } from './clout'
import type { EngineConfig, GoalDef } from './config'
import type { GameSnapshot } from './game'
import {
  claimedGrantKeys,
  goalGrantKey,
  previewGrant,
  type GrantAmounts,
  type GrantEligibilityError,
  type GrantSnapshot,
} from './grants'

export interface GoalsState {
  /** The run, from 1; prestige starts the next one. Grant keys carry it (`r<run>`). */
  readonly run: number
  /** Goal id → the personal-clock minute it was first reached this run. */
  readonly achieved: Readonly<Record<string, number>>
  /** The Icon moment: when the victory goal was reached this run, and whether it was seen. */
  readonly icon: { readonly reachedAt: number | null; readonly acknowledged: boolean }
}

export const initialGoalsState: GoalsState = {
  run: 1,
  achieved: {},
  icon: { reachedAt: null, acknowledged: false },
}

/** A snapshot carrying goal state (the save; the economy bot builds one too). */
export interface GoalsSnapshot extends GameSnapshot {
  readonly goals: GoalsState
}

/** Goal clout lives with the other clout measures (src/engine/clout.ts); re-exported here. */
export { goalClout }

export function findGoal(goalId: string, config: EngineConfig): GoalDef | undefined {
  return config.goals.find((goal) => goal.id === goalId)
}

/** The victory goal (exactly one, at the top clout level; createProgressionConfigSchema). */
export function victoryGoal(config: EngineConfig): GoalDef {
  const goal = config.goals.find((entry) => entry.victory === true)
  if (goal === undefined) throw new Error('config/progression.json has no victory goal')
  return goal
}

/** False while the feature behind a goal is not built yet (it shows as coming soon). */
export function isGoalAvailable(goal: GoalDef): boolean {
  return goal.available !== false
}

/** The goal clout a level goal needs, or null for any other goal. */
function levelTarget(goal: GoalDef, config: EngineConfig): number | null {
  if (goal.fact !== 'clout-level' || goal.level === undefined) return null
  const level = findCloutLevel(goal.level, config)
  if (level === undefined) throw new Error(`goal "${goal.id}" names an unknown level`)
  return level.minClout
}

function factHolds(goal: GoalDef, snapshot: GameSnapshot, config: EngineConfig): boolean {
  const { player } = snapshot
  switch (goal.fact) {
    case 'first-paycheck':
      return player.clout.firstPaycheckPaid
    case 'first-outfit':
      // A look kept through prestige is not this run's outfit (Q-8): it reaches no goal.
      return player.inventory.wearables.some((owned) => owned.prestigeKept !== true)
    case 'first-landmark-visit':
      return Object.keys(player.visited).length > 0
    case 'first-club-night':
      return Object.keys(player.clubNights).length > 0
    case 'first-friend':
      // Friends arrive in a later task; the goal is configured as coming soon until then.
      return false
    case 'clout-level':
      return goalClout(player, config) >= (levelTarget(goal, config) ?? Infinity)
  }
}

export interface GoalSync<S extends GoalsSnapshot> {
  /** The save with every newly reached goal recorded (the same object when nothing changed). */
  readonly save: S
  readonly newlyAchieved: readonly string[]
  /** True when this sync reached the victory goal: the Icon moment starts. */
  readonly iconReached: boolean
}

/** Records every available goal whose fact now holds and was not reached yet this run. */
export function syncGoals<S extends GoalsSnapshot>(save: S, config: EngineConfig): GoalSync<S> {
  const { achieved } = save.goals
  const newlyAchieved = config.goals
    .filter(
      (goal) =>
        isGoalAvailable(goal) && !Object.hasOwn(achieved, goal.id) && factHolds(goal, save, config),
    )
    .map((goal) => goal.id)
  if (newlyAchieved.length === 0) return { save, newlyAchieved, iconReached: false }
  const minute = save.clock.minute
  const iconReached = newlyAchieved.includes(victoryGoal(config).id)
  const goals: GoalsState = {
    ...save.goals,
    achieved: { ...achieved, ...Object.fromEntries(newlyAchieved.map((id) => [id, minute])) },
    icon: iconReached ? { reachedAt: minute, acknowledged: false } : save.goals.icon,
  }
  return { save: { ...save, goals }, newlyAchieved, iconReached }
}

export type GoalStatus = 'coming-soon' | 'in-progress' | 'done' | 'claimed'

export interface GoalView {
  readonly id: string
  readonly fact: GoalDef['fact']
  /** The clout level id of a level goal. */
  readonly level: string | null
  readonly victory: boolean
  readonly status: GoalStatus
  /** Progress toward the goal: goal clout of the level's threshold, or 0/1 for a first. */
  readonly progress: { readonly current: number; readonly target: number }
  readonly reward: {
    /** What the goal pays before the cap. */
    readonly requested: GrantAmounts
    /** What claiming now would pay (the grant function's own numbers), or null when it can't. */
    readonly preview: GrantAmounts | null
  }
  /** What the claim paid, once claimed (from the grant log), or null. */
  readonly claimed: GrantAmounts | null
  /** True when the cap holds the preview below the requested reward. */
  readonly capped: boolean
  /** True when the reward can be claimed right now. */
  readonly claimable: boolean
  /** Why a reached, unclaimed reward cannot be claimed right now (an open event), or null. */
  readonly blocked: GrantEligibilityError['reason'] | null
}

/** Every goal as the Goals panel shows it, in config order. */
export function goalsView(save: GrantSnapshot, config: EngineConfig): readonly GoalView[] {
  const claimed = claimedGrantKeys(save)
  const clout = goalClout(save.player, config)
  return config.goals.map((goal): GoalView => {
    const preview = previewGrant(save, goal.id, config)
    const reached = Object.hasOwn(save.goals.achieved, goal.id)
    const key = goalGrantKey(goal.id, save.goals.run)
    const isClaimed = claimed.has(key)
    const status: GoalStatus = !isGoalAvailable(goal)
      ? 'coming-soon'
      : isClaimed
        ? 'claimed'
        : reached
          ? 'done'
          : 'in-progress'
    const target = levelTarget(goal, config)
    const done = status === 'done' || status === 'claimed'
    const progress =
      target === null
        ? { current: done ? 1 : 0, target: 1 }
        : { current: done ? target : Math.min(clout, target), target }
    const applied = preview.ok ? preview.applied : null
    return {
      id: goal.id,
      fact: goal.fact,
      level: goal.level ?? null,
      victory: goal.victory === true,
      status,
      progress,
      reward: { requested: preview.requested, preview: applied },
      claimed: save.grants.log.find((record) => record.key === key)?.applied ?? null,
      capped:
        applied !== null &&
        (applied.cash < preview.requested.cash || applied.clout < preview.requested.clout),
      claimable: status === 'done' && preview.ok,
      blocked:
        status === 'done' && !preview.ok && preview.error.code === 'INELIGIBLE'
          ? preview.error.reason
          : null,
    }
  })
}

/** Rewards reached and not yet claimed this run (the HUD's Goals button count). */
export function claimableCount(save: GrantSnapshot, config: EngineConfig): number {
  const claimed = claimedGrantKeys(save)
  return config.goals.filter(
    (goal) =>
      isGoalAvailable(goal) &&
      Object.hasOwn(save.goals.achieved, goal.id) &&
      !claimed.has(goalGrantKey(goal.id, save.goals.run)),
  ).length
}

/**
 * True once the player has reached any goal in any run: the "Save your progress" prompt
 * appears only after the first milestone (CLAUDE.md principle 1).
 */
export function firstMilestoneReached(save: Pick<GrantSnapshot, 'goals' | 'prestige'>): boolean {
  return Object.keys(save.goals.achieved).length > 0 || save.prestige.count > 0
}
