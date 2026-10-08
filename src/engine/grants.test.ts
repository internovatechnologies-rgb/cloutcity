/**
 * The one grant function (S15): idempotent (engine-built keys, replay), audited (the log),
 * eligibility-targeted, capped relative to the next progression goal, and never counted toward
 * goal progress (ECON-1).
 */
import { describe, expect, it } from 'vitest'
import { playerLevel, totalClout } from './clout'
import { engineConfig, type EngineConfig } from './config'
import { goalClout, syncGoals } from './goals'
import {
  claimedGrantKeys,
  goalGrantKey,
  goalReward,
  grant,
  grantCaps,
  grantCeilings,
  parseGoalGrantKey,
  previewGrant,
  prestigeBadge,
  toServerGrantRow,
  type GoalRewardRequest,
} from './grants'
import { rentReserve } from './housing'
import { createRng, type Rng } from './rng'
import { initialSave, type SaveState } from './save'
import { playerWithClout } from './test-support'

const config = engineConfig
const NOW = 4000

function save(options: { clout?: number; cash?: number; home?: SaveState['player']['home'] } = {}) {
  const base = initialSave(config)
  const player = playerWithClout(
    {
      ...base.player,
      cash: options.cash ?? base.player.cash,
      home: options.home ?? base.player.home,
    },
    options.clout ?? 0,
    config,
  )
  return { ...base, clock: { minute: NOW, remainderMs: 0 }, player }
}

/** `s` with every available goal marked reached (whatever its fact says). */
function allReached(s: SaveState, cfg: EngineConfig = config): SaveState {
  const achieved = Object.fromEntries(
    cfg.goals.filter((goal) => goal.available !== false).map((goal) => [goal.id, s.clock.minute]),
  )
  return { ...s, goals: { ...s.goals, achieved } }
}

function request(goalId: string, cfg: EngineConfig = config): GoalRewardRequest {
  const goal = cfg.goals.find((entry) => entry.id === goalId)
  if (goal === undefined) throw new Error(`no goal ${goalId}`)
  return { kind: 'goal_reward', goalId, reward: goal.reward }
}

const MS = 1_760_000_000_000

describe('grant keys', () => {
  it('are built by the engine from the goal and the run, and parse back', () => {
    expect(goalGrantKey('first-paycheck', 3)).toBe('goal:first-paycheck:r3')
    expect(parseGoalGrantKey('goal:first-paycheck:r3')).toEqual({
      goalId: 'first-paycheck',
      run: 3,
    })
    for (const bad of ['goal:x:r0', 'goal:X:r1', 'grant:x:r1', 'goal:x:r1:extra', 'goal::r1']) {
      expect(parseGoalGrantKey(bad), bad).toBeNull()
    }
  })
})

describe('grant: idempotent and audited', () => {
  const reached = allReached(save())

  it('applies cash and clout, writes one audit record and records the clout as `grant`', () => {
    const result = grant(reached, request('first-paycheck'), MS, config)
    if (!result.ok) throw new Error(result.error.code)
    const { record } = result
    expect(record).toEqual({
      seq: 1,
      key: 'goal:first-paycheck:r1',
      kind: 'goal_reward',
      eligibility: { rule: 'goal-achieved', goalId: 'first-paycheck', run: 1 },
      reason: 'Goal reward: first-paycheck',
      requested: { cash: 25, clout: 5, badge: null },
      cap: grantCaps(reached, config),
      applied: { cash: 25, clout: 5, badge: null },
      at: NOW,
      issuedAtMs: MS,
      issuedBy: 'system',
      campaignId: null,
      sync: 'local',
    })
    expect(result.replayed).toBe(false)
    expect(result.save.player.cash).toBe(reached.player.cash + 25)
    expect(totalClout(result.save.player, config)).toBe(5)
    expect(result.save.player.clout.ledger.at(-1)).toMatchObject({
      source: 'grant',
      amount: 5,
      ref: { grantKey: 'goal:first-paycheck:r1' },
    })
    expect(result.save.grants).toEqual({ log: [record], nextSeq: 2 })
  })

  it('a repeat call replays the original record and leaves state unchanged', () => {
    const first = grant(reached, request('first-paycheck'), MS, config)
    if (!first.ok) throw new Error(first.error.code)
    const again = grant(first.save, request('first-paycheck'), MS + 999, config)
    expect(again).toEqual({
      ok: true,
      save: first.save,
      record: first.record,
      replayed: true,
      levelUp: null,
    })
    if (again.ok) expect(again.save).toBe(first.save)
  })

  it('a key claimed only in the ledger (the log dropped it) cannot be claimed again', () => {
    const first = grant(reached, request('first-paycheck'), MS, config)
    if (!first.ok) throw new Error(first.error.code)
    const trimmed = { ...first.save, grants: { ...first.save.grants, log: [] } }
    expect(claimedGrantKeys(trimmed).has('goal:first-paycheck:r1')).toBe(true)
    expect(grant(trimmed, request('first-paycheck'), MS, config)).toEqual({
      ok: false,
      error: { code: 'INELIGIBLE', reason: 'already-claimed' },
    })
  })

  it('refuses a tampered reward (more, less or extra) and an unknown kind', () => {
    for (const reward of [
      { cash: 1000, clout: 5 },
      { cash: 25 },
      { cash: 25, clout: 5, badge: true as const },
    ]) {
      expect(
        grant(reached, { kind: 'goal_reward', goalId: 'first-paycheck', reward }, MS, config),
      ).toEqual({ ok: false, error: { code: 'INVALID_REWARD' } })
    }
    const unknownKind = {
      ...request('first-paycheck'),
      kind: 'compensation',
    } as unknown as GoalRewardRequest
    expect(grant(reached, unknownKind, MS, config)).toEqual({
      ok: false,
      error: { code: 'INVALID_REWARD' },
    })
  })

  it('refuses a bad issue time loudly (a caller bug, not a player action)', () => {
    for (const ms of [-1, 1.5, Number.NaN]) {
      expect(() => grant(reached, request('first-paycheck'), ms, config)).toThrow(RangeError)
    }
  })

  it('trims the log to grants.log.maxEntries, oldest first, and keeps seq rising', () => {
    const small = { ...config, grants: { ...config.grants, log: { maxEntries: 2 } } }
    let s = allReached(save(), small)
    for (const id of ['first-paycheck', 'first-outfit', 'first-landmark-visit']) {
      const result = grant(s, request(id, small), MS, small)
      if (!result.ok) throw new Error(result.error.code)
      s = result.save
    }
    expect(s.grants.log.map((record) => [record.seq, record.eligibility.goalId])).toEqual([
      [2, 'first-outfit'],
      [3, 'first-landmark-visit'],
    ])
    expect(s.grants.nextSeq).toBe(4)
  })
})

describe('grant: eligibility', () => {
  it.each<[string, (s: SaveState) => SaveState, string, string]>([
    ['an unknown goal', (s) => allReached(s), 'no-such-goal', 'unknown-goal'],
    ['a goal not reached', (s) => s, 'first-paycheck', 'not-achieved'],
    ['a coming-soon goal', (s) => allReached(s), 'first-friend', 'coming-soon'],
    [
      'an open event',
      (s) => ({ ...allReached(s), events: { ...s.events, active: 'probe' } }),
      'first-paycheck',
      'event-open',
    ],
  ])('refuses %s', (_label, setup, goalId, reason) => {
    const s = setup(save())
    const req =
      goalId === 'no-such-goal'
        ? { kind: 'goal_reward' as const, goalId, reward: {} }
        : request(goalId)
    const result = grant(s, req, MS, config)
    expect(result).toEqual({ ok: false, error: { code: 'INELIGIBLE', reason } })
    expect(previewGrant(s, goalId, config).ok).toBe(false)
  })

  it('a reached goal of a past run is a new key in the next run', () => {
    const s = allReached(save())
    const first = grant(s, request('first-paycheck'), MS, config)
    if (!first.ok) throw new Error(first.error.code)
    const nextRun = { ...first.save, goals: { ...first.save.goals, run: 2 } }
    const second = grant(nextRun, request('first-paycheck'), MS, config)
    if (!second.ok) throw new Error(second.error.code)
    expect(second.replayed).toBe(false)
    expect(second.record.key).toBe('goal:first-paycheck:r2')
  })

  it('with rewardsRepeat off, later runs pay no cash or clout, but the badge still comes', () => {
    const once = { ...config, prestige: { ...config.prestige, rewardsRepeat: false } }
    const local = once.goals.find((goal) => goal.id === 'reach-local')
    const icon = once.goals.find((goal) => goal.id === 'reach-icon')
    if (local === undefined || icon === undefined) throw new Error('goals missing')
    expect(goalReward(local, 1, once)).toEqual({ cash: 50, clout: 15, badge: null })
    expect(goalReward(local, 2, once)).toEqual({ cash: 0, clout: 0, badge: null })
    expect(goalReward(icon, 2, once)).toEqual({ cash: 0, clout: 0, badge: 'prestige-2' })
  })

  it('each run earns its badge in order, the last one again past the end', () => {
    expect([1, 2, 3, 4, 9].map((run) => prestigeBadge(run, config))).toEqual([
      'prestige-1',
      'prestige-2',
      'prestige-3',
      'prestige-3',
      'prestige-3',
    ])
  })
})

describe('grant caps: relative to the next progression goal', () => {
  it('clout: 25% of the gap to the next level, at most maxPerGrant; 0 at the top level', () => {
    expect(grantCaps(save({ clout: 0 }), config).clout).toBe(25)
    expect(grantCaps(save({ clout: 60 }), config).clout).toBe(10)
    expect(grantCaps(save({ clout: 99 }), config).clout).toBe(0)
    expect(grantCaps(save({ clout: 5000 }), config).clout).toBe(0)
    expect(grantCaps(save({ clout: 9999 }), config).clout).toBe(0)
  })

  it('cash: 25% of what the next home up still needs, at most maxPerGrant; 0 in the top home', () => {
    const s = save({ cash: 150 })
    // Queens room: rent reserve 280 + Brooklyn move-in 400 - 150 held = 530 → 132, capped at 100.
    expect(rentReserve(s.player, config)).toBe(280)
    expect(grantCaps(s, config).cash).toBe(100)
    expect(grantCaps(save({ cash: 600 }), config).cash).toBe(20)
    expect(grantCaps(save({ cash: 680 }), config).cash).toBe(0)
    expect(grantCaps(save({ cash: 5000 }), config).cash).toBe(0)
    // Brooklyn 1BR → the Manhattan loft: 520 + 1000 - 1000 = 520 → 130 → 100.
    expect(grantCaps(save({ cash: 1000, home: 'brooklyn-1br' }), config).cash).toBe(100)
    expect(grantCaps(save({ cash: 0, home: 'manhattan-loft' }), config).cash).toBe(0)
  })

  it('applies min(requested, cap) and the preview is exactly what lands (GR-11)', () => {
    const s = allReached(save({ clout: 95, cash: 670 }))
    const preview = previewGrant(s, 'reach-local', config)
    const result = grant(s, request('reach-local'), MS, config)
    if (!preview.ok || !result.ok) throw new Error('expected both to succeed')
    expect(preview.applied).toEqual({ cash: 2, clout: 1, badge: null })
    expect(result.record.applied).toEqual(preview.applied)
    expect(result.record.cap).toEqual(preview.cap)
    expect(result.save.player.cash).toBe(672)
  })
})

/** A config where caps bind hard: 99% of the gap and large rewards. */
const tight: EngineConfig = {
  ...config,
  goals: config.goals.map((goal) =>
    goal.reward.badge === true ? goal : { ...goal, reward: { cash: 900, clout: 900 } },
  ),
  grants: {
    ...config.grants,
    capPctOfGap: { cash: 99, clout: 99 },
    maxPerGrant: { cash: 1000, clout: 1000 },
  },
}

const pick = <T>(rng: Rng, list: readonly T[]): T => {
  const value = list[Math.floor(rng.next() * list.length)]
  if (value === undefined) throw new Error('empty list')
  return value
}

describe('properties: 1000 random grants', () => {
  for (const [label, cfg] of [
    ['shipped caps', config],
    ['caps at 99% with large rewards', tight],
  ] as const) {
    it(`${label}: never change the level, achievements or goal clout; cash within its cap`, () => {
      const rng = createRng(0x5e15)
      const homes = ['queens-room', 'brooklyn-1br', 'manhattan-loft'] as const
      const goalIds = cfg.goals.map((goal) => goal.id)
      let chained = allReached(save({ clout: 37, cash: 10 }), cfg)
      for (let i = 0; i < 1000; i++) {
        // Independent: a random player, a random goal.
        const s = allReached(
          save({
            clout: Math.floor(rng.next() * 6000),
            cash: Math.floor(rng.next() * 3000),
            home: pick(rng, homes),
          }),
          cfg,
        )
        const goalId = pick(rng, goalIds)
        const before = syncGoals(s, cfg).save
        const preview = previewGrant(before, goalId, cfg)
        const result = grant(before, request(goalId, cfg), MS + i, cfg)
        if (result.ok) {
          const after = result.save
          expect(playerLevel(after.player, cfg)).toEqual(playerLevel(before.player, cfg))
          expect(goalClout(after.player, cfg)).toBe(goalClout(before.player, cfg))
          expect(syncGoals(after, cfg).newlyAchieved).toEqual([])
          expect(after.goals).toBe(before.goals)
          expect(after.player.cash - before.player.cash).toBeLessThanOrEqual(result.record.cap.cash)
          expect(preview.ok && preview.applied).toEqual(result.record.applied)
        }
        // Chained: grants one after another, a new run each time, so they keep stacking.
        chained = { ...chained, goals: { ...chained.goals, run: i + 1 } }
        const levelBefore = playerLevel(chained.player, cfg)
        const goalCloutBefore = goalClout(chained.player, cfg)
        const next = grant(chained, request(goalId, cfg), MS + i, cfg)
        if (next.ok) chained = next.save
        expect(playerLevel(chained.player, cfg)).toEqual(levelBefore)
        expect(goalClout(chained.player, cfg)).toBe(goalCloutBefore)
      }
      expect(chained.grants.log.length).toBeGreaterThan(100)
    })
  }
})

describe('toServerGrantRow and grantCeilings (S18c)', () => {
  it('maps a record to the grants columns: the engine key per user, the clout cap in its column (SEC-8)', () => {
    const s = allReached(save({ clout: 60 }))
    const result = grant(s, request('reach-local'), MS, config)
    if (!result.ok) throw new Error(result.error.code)
    const userId = '00000000-0000-4000-8000-000000000001'
    expect(toServerGrantRow(result.record, userId)).toEqual({
      user_id: userId,
      kind: 'goal_reward',
      idempotency_key: 'goal:reach-local:r1',
      cash_amount: 50,
      clout_amount: 10,
      item_id: null,
      cap_amount: result.record.cap.cash,
      clout_cap: 10,
      eligibility: {
        rule: 'goal-achieved',
        goalId: 'reach-local',
        run: 1,
        requested: { cash: 50, clout: 15, badge: null },
        localSeq: 1,
        at: NOW,
        issuedAtMs: MS,
      },
      reason: 'Goal reward: reach-local',
      issued_by: 'system',
      campaign_id: null,
    })
  })

  it('a badge travels as the item id', () => {
    const s = allReached(save({ clout: 5000 }))
    const result = grant(s, request('reach-icon'), MS, config)
    if (!result.ok) throw new Error(result.error.code)
    expect(toServerGrantRow(result.record, 'u').item_id).toBe('prestige-1')
    expect(result.save.prestige.badges).toEqual(['prestige-1'])
  })

  it('ceilings come from config: the largest reward per grant, every reward per run', () => {
    expect(grantCeilings(config)).toEqual({
      perGrant: { cash: 100, clout: 25 },
      perRun: { cash: 405, clout: 110 },
    })
  })
})
