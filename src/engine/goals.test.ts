/** Goals (S15): facts read from saved state, sticky achievements, goal clout and the panel view. */
import { describe, expect, it } from 'vitest'
import { appendClout, totalClout } from './clout'
import { engineConfig as config } from './config'
import {
  claimableCount,
  firstMilestoneReached,
  goalClout,
  goalsView,
  syncGoals,
  victoryGoal,
  type GoalView,
} from './goals'
import { goalGrantKey, grant } from './grants'
import { buyItem, sellItem, shopItems, isWearable } from './items'
import { initialSave, type SaveState } from './save'
import { playerWithClout } from './test-support'

const NOW = 3000
const fresh = (): SaveState => ({ ...initialSave(config), clock: { minute: NOW, remainderMs: 0 } })

function withEarned(save: SaveState, total: number): SaveState {
  return { ...save, player: playerWithClout(save.player, total, config) }
}

/** `save` with `amount` clout recorded from `source` at face value (no level-up check). */
function withEntry(save: SaveState, source: 'grant' | 'premium', amount: number): SaveState {
  const ref =
    source === 'grant'
      ? { grantKey: 'goal:probe:r1' }
      : { itemId: 'premium-probe', op: 'grant' as const }
  const { state } = appendClout(
    save.player.clout,
    { source, amount, ref } as Parameters<typeof appendClout>[1],
    save.clock.minute,
    config,
  )
  return { ...save, player: { ...save.player, clout: state } }
}

const wearable = (() => {
  const found = shopItems(config).find(isWearable)
  if (found === undefined) throw new Error('no wearable in the shop')
  return found
})()

const viewOf = (save: SaveState, id: string): GoalView => {
  const view = goalsView(save, config).find((entry) => entry.id === id)
  if (view === undefined) throw new Error(`no goal ${id}`)
  return view
}

describe('syncGoals: each fact, read from saved state', () => {
  it('a fresh save has reached nothing, and syncing changes nothing (same object)', () => {
    const save = fresh()
    const synced = syncGoals(save, config)
    expect(synced).toEqual({ save, newlyAchieved: [], iconReached: false })
    expect(synced.save).toBe(save)
  })

  it.each<[string, (save: SaveState) => SaveState]>([
    [
      'first-paycheck',
      (save) => ({
        ...save,
        player: { ...save.player, clout: { ...save.player.clout, firstPaycheckPaid: true } },
      }),
    ],
    [
      'first-outfit',
      (save) => {
        const bought = buyItem(
          { ...save, player: { ...save.player, cash: 5000 } },
          wearable.id,
          config,
        )
        if (!bought.ok) throw new Error(bought.error.code)
        return { ...save, player: bought.snapshot.player }
      },
    ],
    [
      'first-landmark-visit',
      (save) => ({ ...save, player: { ...save.player, visited: { 'brooklyn-bridge': NOW } } }),
    ],
    [
      'first-club-night',
      (save) => ({ ...save, player: { ...save.player, clubNights: { 'probe-club': 2 } } }),
    ],
    ['reach-local', (save) => withEarned(save, 100)],
  ])('%s is recorded at the current minute', (goalId, change) => {
    const { save, newlyAchieved, iconReached } = syncGoals(change(fresh()), config)
    expect(newlyAchieved).toEqual([goalId])
    expect(save.goals.achieved).toEqual({ [goalId]: NOW })
    expect(iconReached).toBe(false)
  })

  it('the first friend stays coming soon and is never reached', () => {
    const save = syncGoals(withEarned(fresh(), 10_000), config).save
    expect(save.goals.achieved['first-friend']).toBeUndefined()
    expect(viewOf(save, 'first-friend').status).toBe('coming-soon')
  })

  it('is idempotent: a second sync reaches nothing new and keeps the first minute', () => {
    const once = syncGoals(withEarned(fresh(), 350), config).save
    const later = { ...once, clock: { minute: NOW + 500, remainderMs: 0 } }
    const twice = syncGoals(later, config)
    expect(twice.newlyAchieved).toEqual([])
    expect(twice.save).toBe(later)
    expect(twice.save.goals.achieved).toEqual({ 'reach-local': NOW, 'reach-scene-regular': NOW })
  })

  it('achievements are sticky: selling the outfit or dropping clout keeps the goal', () => {
    const rich = { ...fresh(), player: { ...fresh().player, cash: 5000 } }
    const bought = buyItem(rich, wearable.id, config)
    if (!bought.ok) throw new Error(bought.error.code)
    const reached = syncGoals({ ...rich, player: bought.snapshot.player }, config).save
    const sold = sellItem(reached, wearable.id, config)
    if (!sold.ok) throw new Error(sold.error.code)
    const after = syncGoals({ ...reached, player: sold.snapshot.player }, config).save
    expect(after.player.inventory.wearables).toEqual([])
    expect(after.goals.achieved['first-outfit']).toBe(NOW)
    expect(viewOf(after, 'first-outfit').status).toBe('done')
  })

  it('reaching Icon reaches every level goal and starts the Icon moment', () => {
    const { save, newlyAchieved, iconReached } = syncGoals(withEarned(fresh(), 5000), config)
    expect(newlyAchieved).toEqual([
      'reach-local',
      'reach-scene-regular',
      'reach-known',
      'reach-famous',
      'reach-icon',
    ])
    expect(iconReached).toBe(true)
    expect(victoryGoal(config).id).toBe('reach-icon')
    expect(save.goals.icon).toEqual({ reachedAt: NOW, acknowledged: false })
  })
})

describe('goal clout (ECON-1): earned, never granted, never premium', () => {
  it('counts earned and item clout', () => {
    const save = withEarned(fresh(), 40)
    expect(goalClout(save.player, config)).toBe(40)
  })

  it('subtracts granted clout, so a grant cannot reach a level goal', () => {
    const save = withEntry(withEarned(fresh(), 90), 'grant', 20)
    expect(totalClout(save.player, config)).toBe(110)
    expect(goalClout(save.player, config)).toBe(90)
    expect(syncGoals(save, config).newlyAchieved).toEqual([])
    expect(viewOf(save, 'reach-local').progress).toEqual({ current: 90, target: 100 })
  })

  it('ignores premium clout', () => {
    const save = withEntry(withEarned(fresh(), 90), 'premium', 50)
    expect(totalClout(save.player, config)).toBe(140)
    expect(goalClout(save.player, config)).toBe(90)
  })

  it('never goes below 0 when a loss ate into granted clout', () => {
    const granted = withEntry(fresh(), 'grant', 20)
    const { state } = appendClout(
      granted.player.clout,
      { source: 'event', amount: -15, ref: { eventId: 'e', choiceId: 'c' } },
      NOW,
      config,
    )
    expect(goalClout({ ...granted.player, clout: state }, config)).toBe(0)
  })
})

describe('goalsView, claimableCount, firstMilestoneReached', () => {
  it('lists every goal in config order with its status and progress', () => {
    const save = syncGoals(withEarned(fresh(), 150), config).save
    const views = goalsView(save, config)
    expect(views.map((view) => view.id)).toEqual(config.goals.map((goal) => goal.id))
    expect(viewOf(save, 'reach-local')).toMatchObject({
      status: 'done',
      progress: { current: 100, target: 100 },
      claimable: true,
      blocked: null,
    })
    expect(viewOf(save, 'reach-scene-regular')).toMatchObject({
      status: 'in-progress',
      progress: { current: 150, target: 300 },
      claimable: false,
    })
    expect(viewOf(save, 'first-outfit')).toMatchObject({
      status: 'in-progress',
      progress: { current: 0, target: 1 },
    })
  })

  it('previews exactly what a claim applies, capped, and flags the cap', () => {
    const save = syncGoals(withEarned(fresh(), 290), config).save
    const view = viewOf(save, 'reach-local')
    // 25% of the 10 clout still needed for Scene Regular: 2, not the configured 15.
    expect(view.reward.requested).toEqual({ cash: 50, clout: 15, badge: null })
    expect(view.reward.preview?.clout).toBe(2)
    expect(view.capped).toBe(true)
    const claimed = grant(
      save,
      { kind: 'goal_reward', goalId: 'reach-local', reward: { cash: 50, clout: 15 } },
      1,
      config,
    )
    if (!claimed.ok) throw new Error(claimed.error.code)
    expect(claimed.record.applied).toEqual(view.reward.preview)
    const after = viewOf(claimed.save, 'reach-local')
    expect(after.status).toBe('claimed')
    expect(after.claimed).toEqual(view.reward.preview)
    expect(after.claimable).toBe(false)
  })

  it('a reached reward cannot be claimed during an event, and says why', () => {
    const save = syncGoals(withEarned(fresh(), 100), config).save
    const busy = { ...save, events: { ...save.events, active: 'probe-event' } }
    expect(viewOf(busy, 'reach-local')).toMatchObject({
      status: 'done',
      claimable: false,
      blocked: 'event-open',
    })
  })

  it('counts rewards ready to claim, and the first milestone', () => {
    const start = fresh()
    expect(claimableCount(start, config)).toBe(0)
    expect(firstMilestoneReached(start)).toBe(false)
    const save = syncGoals(withEarned(start, 350), config).save
    expect(claimableCount(save, config)).toBe(2)
    expect(firstMilestoneReached(save)).toBe(true)
    const claimed = grant(
      save,
      { kind: 'goal_reward', goalId: 'reach-local', reward: { cash: 50, clout: 15 } },
      1,
      config,
    )
    if (!claimed.ok) throw new Error(claimed.error.code)
    expect(claimableCount(claimed.save, config)).toBe(1)
    expect(claimed.save.grants.log[0]?.key).toBe(goalGrantKey('reach-local', 1))
  })
})
