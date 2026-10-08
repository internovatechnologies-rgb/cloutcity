/**
 * Player-facing text for goals, rewards, the Icon moment and prestige (S15), built from the
 * engine's goal views through the copy layer and the shared formatters. Amounts always come
 * from the grant function's own preview, so what a button promises is what lands (GR-11).
 */
import type { GoalView } from '@/engine/goals'
import type { GrantAmounts } from '@/engine/grants'
import type { PrestigePart } from '@/lib/data/goalFacts'
import { copy as activeCopy, isCopyKey, type CopyFn, type CopyKey } from './copy'
import { formatCount, formatMoney } from './format'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/goals'

export interface GoalsCopyOptions {
  readonly copy?: CopyFn
}

function requireKey(key: string, what: string): CopyKey {
  if (!isCopyKey(key)) throw new Error(`No copy key "${key}" for ${what}`)
  return key
}

/** `first-paycheck` → `firstPaycheck`, the copy-key segment for a kebab-case id. */
function camelSegment(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, next: string) => next.toUpperCase())
}

/** "First paycheck". */
export function goalName(goalId: string, { copy = activeCopy }: GoalsCopyOptions = {}): string {
  return copy(requireKey(`goals.goal.${camelSegment(goalId)}.name`, `goal ${goalId}`))
}

/** "Work any shift." */
export function goalHint(goalId: string, { copy = activeCopy }: GoalsCopyOptions = {}): string {
  return copy(requireKey(`goals.goal.${camelSegment(goalId)}.hint`, `goal ${goalId}`))
}

/** "Prestige I". */
export function badgeName(badgeId: string, { copy = activeCopy }: GoalsCopyOptions = {}): string {
  return copy(requireKey(`goals.badge.${camelSegment(badgeId)}`, `badge ${badgeId}`))
}

/** "Your cash": one line of the prestige confirm's resets and keeps lists. */
export function prestigePartName(
  part: PrestigePart,
  { copy = activeCopy }: GoalsCopyOptions = {},
): string {
  return copy(requireKey(`goals.prestige.part.${part}`, `prestige part ${part}`))
}

/** "$25 and 5 clout", "the Prestige I badge", or "nothing more this time". */
export function rewardText(amounts: GrantAmounts, options: GoalsCopyOptions = {}): string {
  const { copy = activeCopy } = options
  if (amounts.badge !== null)
    return copy('goals.reward.badge', { badge: badgeName(amounts.badge, options) })
  const cash = formatMoney(amounts.cash)
  const clout = formatCount(amounts.clout)
  if (amounts.cash > 0 && amounts.clout > 0)
    return copy('goals.reward.cashAndClout', { cash, clout })
  if (amounts.cash > 0) return copy('goals.reward.cash', { cash })
  if (amounts.clout > 0) return copy('goals.reward.clout', { clout })
  return copy('goals.reward.nothing')
}

/** The progress bar's accessible name: "Reach Local: 40 of 100 earned clout". */
export function goalProgressLabel(view: GoalView, options: GoalsCopyOptions = {}): string {
  const { copy = activeCopy } = options
  const vars = {
    goal: goalName(view.id, options),
    count: formatCount(view.progress.current),
    target: formatCount(view.progress.target),
  }
  return copy(view.level === null ? 'goals.progress.step' : 'goals.progress.level', vars)
}

const STATUS_KEYS = {
  'coming-soon': 'goals.status.comingSoon',
  'in-progress': 'goals.status.inProgress',
  done: 'goals.status.done',
  claimed: 'goals.status.claimed',
} as const satisfies Record<GoalView['status'], CopyKey>

export function goalStatusText(view: GoalView, { copy = activeCopy }: GoalsCopyOptions = {}) {
  return copy(STATUS_KEYS[view.status])
}

/** The amounts a claim pays right now, or what the goal asks for when it cannot be claimed. */
function shownReward(view: GoalView): GrantAmounts {
  return view.reward.preview ?? view.reward.requested
}

/** The reward line: "Reward: $25 and 5 clout" (what was paid, once claimed). */
export function rewardLine(view: GoalView, options: GoalsCopyOptions = {}): string {
  const { copy = activeCopy } = options
  const amounts = view.claimed ?? shownReward(view)
  return copy('goals.reward.label', { reward: rewardText(amounts, options) })
}

/**
 * The Claim button's visible text and accessible name. Enabled, it names the capped amount
 * ("Claim $25 and 5 clout for First paycheck"); disabled, it says why (A11Y-2).
 */
export function claimButton(
  view: GoalView,
  options: GoalsCopyOptions = {},
): { readonly text: string; readonly label: string } {
  const { copy = activeCopy } = options
  const goal = goalName(view.id, options)
  const reward = rewardText(shownReward(view), options)
  const text = copy('goals.claim.button', { reward })
  if (view.claimable) return { text, label: copy('goals.claim.label', { claim: text, goal }) }
  const label =
    view.blocked === 'event-open'
      ? copy('goals.claim.eventOpen', { claim: text, goal })
      : copy('goals.claim.notReached', { claim: text, goal })
  return { text, label }
}

/** The status line after a claim: "First paycheck: claimed $25 and 5 clout." */
export function claimedText(
  goalId: string,
  applied: GrantAmounts,
  options: GoalsCopyOptions = {},
): string {
  const { copy = activeCopy } = options
  return copy('goals.claim.done', {
    goal: goalName(goalId, options),
    reward: rewardText(applied, options),
  })
}
