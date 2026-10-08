/**
 * S18c save plausibility (src/engine/plausibility.ts): normal play is always accepted (the
 * economy and flex bots replayed as uploads at a real pace), and each tampering is repaired or
 * rejected as the module comment rules.
 */
import { describe, expect, it } from 'vitest'
import baselineJson from '@data/sim/economy-baseline.derived.json'
import { sync } from '@/lib/data/config'
import { landmarks, venues } from '@/lib/data/content'
import { EconomyBaselineSchema } from '@/lib/data/schemas/sim'
import { realMsPerGameMinute } from './clock'
import { cloutCeilings, cloutLevel, findCloutLevel, playerLevel } from './clout'
import { engineConfig as config, transitBalance } from './config'
import { jobIds, shiftWage } from './jobs'
import { initialEventsState } from './events'
import { syncGoals } from './goals'
import { goalGrantKey, grant, grantCeilings, prestigeBadge, type GrantRecord } from './grants'
import { buyItem, isDecor, isGift, isWearable, shopItems, type DecorDef } from './items'
import {
  applyRepairs,
  cashCeilings,
  checkUpload,
  type CashClout,
  maxActionGameMinutes,
  plausibilityCeilings,
  type Repair,
  type UploadContext,
  type Verdict,
} from './plausibility'
import { prestige } from './prestige'
import { createSaveSchema, initialSave, loadSave, type SaveState } from './save'
import { runEconomyBot, type BotStep } from './sim/economyBot'
import { maxCloutPlaces } from './sim/maxCloutPlaces'
import { playerWithClout } from './test-support'

const baseline = EconomyBaselineSchema.parse(baselineJson)
const ceilings = plausibilityCeilings(config, baseline, sync)
const schema = createSaveSchema(config)
const MS = 1_760_000_000_000
const DAYS = 30
/** Real milliseconds a person takes per tap: 15 a minute, well under the ceiling. */
const TAP_MS = 4000

const ctx = (patch: Partial<UploadContext> = {}): UploadContext => ({
  realMinutesSinceAccept: 1,
  burstCreditMinutes: sync.plausibility.burstRealMinutes,
  accountAgeMinutes: 24 * 60,
  serverGrantKeys: [],
  entitledItemIds: [],
  firstUpload: false,
  ...patch,
})

const check = (prev: SaveState | null, next: unknown, patch: Partial<UploadContext> = {}) =>
  checkUpload(prev, next, ctx(patch), ceilings, config)

/** A writable deep copy, for tampering. */
type Draft<T> = T extends readonly (infer U)[]
  ? Draft<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Draft<T[K]> }
    : T
const clone = (save: SaveState): Draft<SaveState> => structuredClone(save) as Draft<SaveState>

/**
 * A bot step as the save the store would hold, with the taps the store would have counted so far
 * (`actions`: every action, shift or ride, and every claim).
 */
function asSave(step: BotStep, actions: number): SaveState {
  return {
    ...step.snapshot,
    speed: 1,
    events: initialEventsState(),
    goals: step.goals,
    grants: step.grants,
    prestige: step.prestige,
    actions,
  }
}

interface Played {
  readonly save: SaveState
  /** Real milliseconds the step took a person: a tap, or the passive time it waited. */
  readonly realMs: number
}

const queensBallpark = (() => {
  const found = landmarks.find((landmark) => landmark.id === 'queens-ballpark')
  if (found === undefined) throw new Error('no queens-ballpark')
  return found
})()

type BotKind = 'economy' | 'flex' | 'max-clout'

function play(kind: BotKind): Played[] {
  const steps: Played[] = []
  let minute = initialSave(config).clock.minute
  let taps = 0
  let claims = 0
  runEconomyBot(
    {
      jobId: kind === 'economy' ? 'retail' : 'barista',
      days: DAYS,
      upgradeTo: 'brooklyn-1br',
      claimAll: true,
      ...(kind === 'flex' ? { flex: { place: queensBallpark } } : {}),
      ...(kind === 'max-clout'
        ? { maxClout: maxCloutPlaces([...landmarks, ...venues], config) }
        : {}),
      onStep: (step) => {
        const moved = step.snapshot.clock.minute - minute
        minute = step.snapshot.clock.minute
        if (step.counted) taps += 1
        taps += step.grants.log.length - claims
        claims = step.grants.log.length
        steps.push({
          save: asSave(step, taps),
          realMs: step.counted ? TAP_MS : moved * realMsPerGameMinute(config),
        })
      },
    },
    config,
  )
  return steps
}

const economySteps = play('economy')
const flexSteps = play('flex')
/** The max-clout bot (S18c): as much clout as honest play gets, which sets the honest pace. */
const maxCloutSteps = play('max-clout')

/**
 * Uploads `steps` as the client would: the initial save first, then one upload per `every`
 * steps, each with the real time since the last accept and the grant keys the server holds.
 */
function replay(steps: readonly Played[], every: number) {
  let prev: SaveState | null = null
  const server = new Set<string>()
  let sinceAccept = 0
  let credit = 0
  let pace: CashClout | null = null
  let age = 0
  const verdicts: { verdict: Verdict; upload: SaveState }[] = []
  const upload = (save: SaveState, first: boolean) => {
    const verdict = check(prev, save, {
      realMinutesSinceAccept: sinceAccept / 60_000,
      burstCreditMinutes: credit,
      paceCredit: pace,
      accountAgeMinutes: age / 60_000,
      serverGrantKeys: [...server],
      firstUpload: first,
    })
    verdicts.push({ verdict, upload: save })
    if (verdict.save !== null) {
      prev = verdict.save
      sinceAccept = 0
      credit = verdict.burstCreditMinutes ?? credit
      pace = verdict.paceCredit ?? pace
      for (const record of verdict.grantsToInsert) server.add(record.key)
    }
  }
  upload(initialSave(config), true)
  steps.forEach((step, i) => {
    sinceAccept += step.realMs
    age += step.realMs
    if ((i + 1) % every === 0 || i === steps.length - 1) upload(step.save, false)
  })
  return { verdicts, server }
}

describe('normal play is never flagged (false-positive guard)', () => {
  it.each([
    ['economy bot (retail), every step', economySteps, 1],
    ['economy bot (retail), every 15 steps', economySteps, 15],
    ['flex bot (barista), every step', flexSteps, 1],
    ['flex bot (barista), every 15 steps', flexSteps, 15],
    ['max-clout bot (barista), every step', maxCloutSteps, 1],
    ['max-clout bot (barista), every 15 steps', maxCloutSteps, 15],
  ])('%s: every upload is accepted unchanged', (_label, steps, every) => {
    const { verdicts, server } = replay(steps, every)
    expect(verdicts.length).toBeGreaterThan(steps.length / every)
    for (const { verdict, upload } of verdicts) {
      const where = `day ${Math.floor(upload.clock.minute / 1440) + 1}: ${verdict.findings.join(', ')}`
      expect(verdict.outcome, where).toBe('accept')
      expect(verdict.findings, where).toEqual([])
      expect(verdict.save, where).toEqual(upload)
      expect(verdict.publicView?.level_index, where).toBe(playerLevel(upload.player, config).index)
    }
    // Every goal reward the bot claimed reached the server exactly once.
    const last = verdicts.at(-1)?.upload
    expect([...server].sort()).toEqual(last?.grants.log.map((record) => record.key).sort())
  })

  it('the bots really do earn what the checks look at: grants, flexes, a level', () => {
    const last = flexSteps.at(-1)?.save
    if (last === undefined) throw new Error('no steps')
    expect(last.grants.log.length).toBeGreaterThanOrEqual(2)
    expect(playerLevel(last.player, config).id).toBe('local')
    expect(last.player.clout.ledger.some((entry) => entry.source === 'flex')).toBe(true)
  })

  it('the public view carries the level and the outfit; no career path until S16a (DEC-20)', () => {
    const last = economySteps.at(-1)?.save
    if (last === undefined) throw new Error('no steps')
    const verdict = check(null, last, { firstUpload: true })
    expect(verdict.publicView).toEqual({
      level_id: 'nobody',
      level_index: 0,
      career_path: null,
      cosmetics: [],
    })
    expect(verdict.sameRun).toBe(false)
  })
})

/** The flex bot's state around its first goal claim: before it, and with it. */
function aroundClaim(): { readonly prev: SaveState; readonly next: SaveState } {
  const index = flexSteps.findIndex((step) => step.save.grants.log.length > 0)
  const prev = flexSteps[index - 1]?.save
  const next = flexSteps[index]?.save
  if (prev === undefined || next === undefined) throw new Error('the bot claimed nothing')
  return { prev, next }
}

/** The flex bot's last day, accepted, and an upload a minute later. */
function lateRun(): SaveState {
  const last = flexSteps.at(-1)?.save
  if (last === undefined) throw new Error('no steps')
  return last
}

const later = (save: SaveState, minutes = 1): Draft<SaveState> => {
  const next = clone(save)
  next.clock.minute += minutes
  return next
}

const serverKeys = (save: SaveState) => save.grants.log.map((record) => record.key)

describe('tampering', () => {
  const prev = lateRun()
  const keys = serverKeys(prev)

  it('an unchanged upload a minute later is accepted', () => {
    const verdict = check(prev, later(prev), { serverGrantKeys: keys })
    expect(verdict.outcome).toBe('accept')
  })

  it('a previous save read back from jsonb (keys reordered) compares the same', () => {
    const reorder = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reorder)
        : typeof value === 'object' && value !== null
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([k, v]) => [k, reorder(v)]),
            )
          : value
    const stored = reorder(prev) as SaveState
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(prev))
    const verdict = check(stored, later(prev), { serverGrantKeys: keys })
    expect(verdict.outcome).toBe('accept')
  })

  it('a forged goal is dropped (SEC-9), and claiming it rejects', () => {
    const next = later(prev)
    expect(Object.keys(next.player.clubNights)).toEqual([])
    next.goals = { ...next.goals, achieved: { ...next.goals.achieved, 'first-club-night': 1 } }
    const verdict = check(prev, next, { serverGrantKeys: keys })
    expect(verdict.outcome).toBe('repair')
    expect(verdict.findings).toEqual(['goal-without-fact'])
    expect(verdict.repairs).toEqual([
      { kind: 'drop-goal', goalId: 'first-club-night', victory: false },
    ])
    expect(verdict.save?.goals.achieved).toEqual(prev.goals.achieved)

    const claimed = grant(
      { ...next, events: initialEventsState() },
      { kind: 'goal_reward', goalId: 'first-club-night', reward: { cash: 20, clout: 10 } },
      MS,
      config,
    )
    if (!claimed.ok) throw new Error(claimed.error.code)
    const rejected = check(prev, claimed.save, { serverGrantKeys: keys })
    expect(rejected.outcome).toBe('reject')
    expect(rejected.findings).toContain('grant-invalid')
    expect(rejected.save).toBeNull()
    expect(rejected.grantsToInsert).toEqual([])
  })

  it('a forged level goal is dropped when goal clout never reached the level', () => {
    const next = later(prev)
    next.goals = { ...next.goals, achieved: { ...next.goals.achieved, 'reach-known': 1 } }
    next.player = { ...next.player, clout: { ...next.player.clout, peakLevel: 3 } }
    const verdict = check(prev, next, { serverGrantKeys: keys })
    expect(verdict.findings).toContain('goal-without-fact')
    expect(verdict.findings).toContain('peak-above-reachable')
    expect(verdict.save?.player.clout.peakLevel).toBe(prev.player.clout.peakLevel)
  })

  it('a forged badge is dropped', () => {
    const next = later(prev)
    next.prestige = { ...next.prestige, badges: ['prestige-1'] }
    const verdict = check(prev, next, { serverGrantKeys: keys })
    expect(verdict.outcome).toBe('repair')
    expect(verdict.findings).toEqual(['badge-without-run'])
    expect(verdict.save?.prestige.badges).toEqual([])
  })

  it('a forged prestige history rejects', () => {
    const next = later(prev)
    next.prestige = {
      count: 1,
      badges: [],
      history: [{ run: 1, endedAt: 10, issuedAtMs: MS, badge: 'prestige-1' }],
    }
    expect(check(prev, next, { serverGrantKeys: keys }).findings).toContain('prestige-history')
  })

  it('a peak level at Icon without the goal clout for it is refused outright (DEC-13)', () => {
    const next = later(prev)
    const icon = findCloutLevel('icon', config)?.index ?? 0
    next.player = { ...next.player, clout: { ...next.player.clout, peakLevel: icon } }
    expect(check(prev, next, { serverGrantKeys: keys }).findings).toEqual(['structural'])
  })

  it('a peak level above anything the run reached drops back', () => {
    const next = later(prev)
    next.player = { ...next.player, clout: { ...next.player.clout, peakLevel: 4 } }
    const verdict = check(prev, next, { serverGrantKeys: keys })
    expect(verdict.outcome).toBe('repair')
    expect(verdict.findings).toEqual(['peak-above-reachable'])
    expect(verdict.save?.player.clout.peakLevel).toBe(prev.player.clout.peakLevel)
  })

  it('a peak level below the current level is lifted (NOTE-7)', () => {
    const next = later(prev)
    next.player = { ...next.player, clout: { ...next.player.clout, peakLevel: 0 } }
    const verdict = check(prev, next, { serverGrantKeys: keys })
    expect(verdict.findings).toEqual(['peak-below-level'])
    expect(verdict.save?.player.clout.peakLevel).toBe(playerLevel(prev.player, config).index)
  })

  const withPremium = (save: SaveState): Draft<SaveState> => {
    const next = later(save)
    const { clout } = next.player
    const entry = {
      seq: clout.nextSeq,
      at: next.clock.minute,
      amount: 1,
      currency: 'usd',
      source: 'premium',
      ref: { itemId: 'placeholder-badge', op: 'grant' },
    } as const
    next.player = {
      ...next.player,
      clout: { ...clout, ledger: [...clout.ledger.slice(1), entry], nextSeq: clout.nextSeq + 1 },
    }
    // Keep the folded sums whole: the dropped oldest entry moves into them.
    const oldest = clout.ledger[0]
    if (oldest !== undefined && clout.ledger.length === config.clout.ledger.maxEntries) {
      const bySource = { ...clout.compacted.bySource }
      bySource[oldest.source] = (bySource[oldest.source] ?? 0) + oldest.amount
      next.player.clout.compacted = { entries: clout.compacted.entries + 1, bySource }
    } else {
      next.player.clout.ledger = [...clout.ledger, entry]
    }
    return next
  }

  it('premium clout without an entitlement is dropped; with one it stays', () => {
    const next = withPremium(prev)
    const verdict = check(prev, next, { serverGrantKeys: keys })
    expect(verdict.outcome).toBe('repair')
    expect(verdict.findings).toEqual(['premium-without-entitlement'])
    expect(verdict.repairs).toEqual([{ kind: 'drop-premium', itemId: 'placeholder-badge' }])
    expect(verdict.save?.player.clout.ledger.some((e) => e.source === 'premium')).toBe(false)

    const entitled = check(prev, next, {
      serverGrantKeys: keys,
      entitledItemIds: ['placeholder-badge'],
    })
    expect(entitled.outcome).toBe('accept')
  })

  it('a claim the server already holds, made again, rejects', () => {
    const { prev: before, next: after } = aroundClaim()
    const accepted = check(before, after)
    expect(accepted.outcome).toBe('accept')
    expect(accepted.grantsToInsert.length).toBeGreaterThan(0)
    // The server took the claim (from this or another device) but the save it compares against
    // does not hold it: the record is a second payout.
    const verdict = check(before, after, { serverGrantKeys: serverKeys(after) })
    expect(verdict.outcome).toBe('reject')
    expect(verdict.findings).toContain('grant-replayed')
  })

  it.each<[string, (record: GrantRecord) => GrantRecord]>([
    ['a cap above the configured maximum', (r) => ({ ...r, cap: { ...r.cap, clout: 999 } })],
    [
      'a reward other than the configured one',
      (r) => ({
        ...r,
        requested: { ...r.requested, cash: 100 },
        cap: { ...r.cap, cash: 100 },
        applied: { ...r.applied, cash: 100 },
      }),
    ],
    [
      'a goal not reached this run',
      (r) => ({
        ...r,
        key: goalGrantKey('reach-famous', r.eligibility.run),
        eligibility: { ...r.eligibility, goalId: 'reach-famous' },
        reason: 'Goal reward: reach-famous',
        requested: { cash: 100, clout: 25, badge: null },
      }),
    ],
  ])('a grant with %s rejects', (_label, tamper) => {
    const { prev: before, next: after } = aroundClaim()
    const next = clone(after)
    const [record, ...rest] = next.grants.log
    if (record === undefined) throw new Error('no record')
    next.grants = { ...next.grants, log: [tamper(record), ...rest] }
    const verdict = check(before, next)
    expect(verdict.outcome).toBe('reject')
    expect(verdict.findings).toContain('grant-invalid')
  })

  it('grant clout the record does not show (a mismatched ledger) rejects', () => {
    const { prev: before, next: after } = aroundClaim()
    const next = clone(after)
    const ledger = next.player.clout.ledger.map((entry) =>
      entry.source === 'grant' ? { ...entry, amount: entry.amount + 50 } : entry,
    )
    next.player = { ...next.player, clout: { ...next.player.clout, ledger } }
    const verdict = check(before, next)
    expect(verdict.outcome).toBe('reject')
    expect(verdict.findings).toContain('grant-ledger-mismatch')
  })

  it('an older save after a newer one (clock and sequence back) rejects', () => {
    const older = flexSteps.at(-40)?.save
    if (older === undefined) throw new Error('no steps')
    const verdict = check(prev, older, { serverGrantKeys: keys })
    expect(verdict.outcome).toBe('reject')
    expect(verdict.findings).toContain('regressed')
  })

  it('a sequence number put back rejects', () => {
    const ahead = clone(prev)
    ahead.grants = { ...ahead.grants, nextSeq: ahead.grants.nextSeq + 3 }
    const verdict = check(ahead, later(prev), { serverGrantKeys: keys })
    expect(verdict.findings).toEqual(['regressed'])
  })

  it('a reset first paycheck or cleared club nights reject (they would pay again)', () => {
    const next = later(prev)
    next.player = { ...next.player, clout: { ...next.player.clout, firstPaycheckPaid: false } }
    next.goals = {
      ...next.goals,
      achieved: Object.fromEntries(
        Object.entries(next.goals.achieved).filter(([id]) => id !== 'first-paycheck'),
      ),
    }
    expect(check(prev, next, { serverGrantKeys: keys }).findings).toContain('regressed')
  })

  it('a clout spike rejects: one flex worth far more than any flex can give', () => {
    const next = later(prev)
    const { clout } = next.player
    const flex = clout.ledger.findLast((entry) => entry.source === 'flex')
    if (flex === undefined) throw new Error('no flex')
    const ledger = clout.ledger.map((entry) =>
      entry === flex ? { ...entry, amount: 5000 } : entry,
    )
    next.player = { ...next.player, clout: { ...clout, ledger } }
    // From the save before that flex, the spike is new in the window.
    const before = flexSteps.find((step) => step.save.player.clout.nextSeq === flex.seq)?.save
    if (before === undefined) throw new Error('no save before the flex')
    const verdict = check(before, next, { realMinutesSinceAccept: 2 })
    expect(verdict.outcome).toBe('reject')
    expect(verdict.findings).toContain('clout-rate')
  })

  it('folded legacy clout appearing mid-run rejects', () => {
    const next = later(prev)
    const { clout } = next.player
    next.player = {
      ...next.player,
      clout: {
        ...clout,
        compacted: {
          entries: clout.compacted.entries + 1,
          bySource: { ...clout.compacted.bySource, legacy: 1000 },
        },
      },
    }
    expect(check(prev, next, { serverGrantKeys: keys }).findings).toContain('clout-rate')
  })

  it('a cash spike rejects', () => {
    const next = later(prev)
    next.player = { ...next.player, cash: next.player.cash + 100_000 }
    const verdict = check(prev, next, { serverGrantKeys: keys })
    expect(verdict.outcome).toBe('reject')
    expect(verdict.findings).toEqual(['cash-flow', 'honest-pace'])
  })

  it('items that appear without being paid for reject', () => {
    const next = later(prev)
    const gifts = shopItems(config)
      .filter(isGift)
      .map((item) => ({ itemId: item.id, count: config.items.maxGiftStack }))
    const value = gifts.reduce(
      (sum, stack) =>
        sum + stack.count * (shopItems(config).find((i) => i.id === stack.itemId)?.price ?? 0),
      0,
    )
    expect(value).toBeGreaterThan(ceilings.cash.perGameDay)
    next.player = { ...next.player, inventory: { ...next.player.inventory, gifts } }
    const verdict = check(prev, next, { serverGrantKeys: keys })
    expect(verdict.outcome).toBe('reject')
    expect(verdict.findings).toEqual(['cash-flow', 'honest-pace'])
  })

  it('a structurally broken upload rejects', () => {
    expect(check(prev, { ...prev, player: { cash: -1 } }).findings).toEqual(['structural'])
    expect(check(prev, null).outcome).toBe('reject')
  })
})

/** A run that reached Icon, bought a wearable, and prestiged: its look is kept. */
function prestiged(): { readonly before: SaveState; readonly after: SaveState } {
  const base = initialSave(config)
  const wearable = shopItems(config).find(isWearable)
  if (wearable === undefined) throw new Error('no wearable')
  const start = { ...base, clock: { minute: 40 * 1440, remainderMs: 0 } }
  const bought = buyItem({ ...start, player: { ...start.player, cash: 1000 } }, wearable.id, config)
  if (!bought.ok) throw new Error(bought.error.code)
  const atIcon = syncGoals(
    { ...start, player: playerWithClout(bought.snapshot.player, 5000, config) },
    config,
  ).save
  const later5 = { ...atIcon, clock: { ...atIcon.clock, minute: atIcon.clock.minute + 5 } }
  const done = prestige(later5, MS, config)
  if (!done.ok) throw new Error(done.error.code)
  return { before: atIcon, after: done.save }
}

describe('kept items (SEC-10)', () => {
  const { after } = prestiged()

  it('a prestiged run uploads cleanly as a first upload', () => {
    const verdict = check(null, after, { firstUpload: true })
    expect(verdict.findings).not.toContain('kept-item-unmarked')
    expect(verdict.findings).not.toContain('prestige-history')
  })

  it('a kept look with its mark removed is marked again (with or without a previous save)', () => {
    const next = later(after)
    next.player.inventory.wearables = next.player.inventory.wearables.map((owned) => ({
      itemId: owned.itemId,
      acquiredMinute: owned.acquiredMinute,
      worn: owned.worn,
    }))
    for (const verdict of [check(after, next), check(null, next, { firstUpload: true })]) {
      expect(verdict.findings).toContain('kept-item-unmarked')
      expect(verdict.save?.player.inventory.wearables.every((o) => o.prestigeKept === true)).toBe(
        true,
      )
    }
  })

  it('a finished run going missing from the history rejects', () => {
    const { before } = prestiged()
    const verdict = check(after, later(before, 10))
    expect(verdict.outcome).toBe('reject')
    expect(verdict.findings).toContain('regressed')
  })
})

describe('the first upload', () => {
  const last = lateRun()

  it('is never rejected for real time: a month of offline play on a new account', () => {
    const verdict = check(null, last, {
      firstUpload: true,
      realMinutesSinceAccept: 0,
      accountAgeMinutes: 0,
    })
    expect(verdict.outcome).toBe('accept')
    expect(verdict.grantsToInsert.map((r) => r.key).sort()).toEqual(serverKeys(last).sort())
  })

  it('real time binds only after it: more taps than a minute holds', () => {
    const next = later(last)
    next.player.clout.nextSeq += 1000
    expect(check(last, next, { firstUpload: true }).outcome).toBe('accept')
    const verdict = check(last, next, { realMinutesSinceAccept: 1 })
    expect(verdict.outcome).toBe('reject')
    expect(verdict.findings).toEqual(['action-rate'])
  })

  it('is still checked against game time: more cash than the days on the clock allow', () => {
    const next = clone(initialSave(config))
    next.player.cash = 1_000_000
    const verdict = check(null, next, { firstUpload: true })
    expect(verdict.outcome).toBe('reject')
    expect(verdict.findings).toEqual(['cash-flow'])
  })

  it("caps the public level by the account's age", () => {
    const known = findCloutLevel('known', config)
    if (known === undefined) throw new Error('no known level')
    const base = initialSave(config)
    // Known on legacy clout (an old save), ten game days in.
    const save = syncGoals(
      {
        ...base,
        clock: { minute: 10 * 1440, remainderMs: 0 },
        player: playerWithClout(base.player, known.minClout, config),
      },
      config,
    ).save
    const young = check(null, save, { firstUpload: true, accountAgeMinutes: 0 })
    expect(young.outcome).toBe('accept')
    expect(young.findings).toEqual(['public-level-capped'])
    expect(young.publicView?.level_index).toBeLessThan(known.index)
    const old = check(null, save, { firstUpload: true, accountAgeMinutes: 60 })
    expect(old.findings).toEqual([])
    expect(old.publicView).toMatchObject({ level_id: 'known', level_index: known.index })
  })
})

describe('applyRepairs', () => {
  const { after } = prestiged()
  const save = clone(after)
  save.player.inventory.wearables = save.player.inventory.wearables.map((owned) => ({
    itemId: owned.itemId,
    acquiredMinute: owned.acquiredMinute,
    worn: owned.worn,
  }))
  save.prestige = { ...save.prestige, badges: [...save.prestige.badges, 'prestige-2'] }
  save.goals = { ...save.goals, achieved: { 'first-outfit': save.clock.minute } }
  const repairs: Repair[] = [
    { kind: 'drop-goal', goalId: 'first-outfit', victory: false },
    { kind: 'drop-badge', badge: 'prestige-2' },
    { kind: 'mark-kept', itemId: save.player.inventory.wearables[0]?.itemId ?? '' },
    { kind: 'set-peak', peakLevel: 0 },
    { kind: 'drop-premium', itemId: null },
    { kind: 'drop-premium', itemId: 'premium-probe' },
  ]

  it('is idempotent and leaves a valid save', () => {
    const once = applyRepairs(save, repairs)
    expect(applyRepairs(once, repairs)).toEqual(once)
    expect(schema.safeParse(once).success).toBe(true)
    expect(once.goals.achieved).toEqual({})
    expect(once.prestige.badges).toEqual(after.prestige.badges)
    expect(once.player.inventory.wearables.every((owned) => owned.prestigeKept === true)).toBe(true)
  })

  it('does not change the save it is given', () => {
    const copy = clone(save)
    applyRepairs(save, repairs)
    expect(save).toEqual(copy)
  })

  it('dropping the victory goal ends the Icon moment with it', () => {
    const atIcon = prestiged().before
    expect(atIcon.goals.icon.reachedAt).not.toBeNull()
    const dropped = applyRepairs(atIcon, [
      { kind: 'drop-goal', goalId: 'reach-icon', victory: true },
    ])
    expect(dropped.goals.icon).toEqual({ reachedAt: null, acknowledged: false })
    expect(schema.safeParse(dropped).success).toBe(true)
  })
})

describe('ceilings', () => {
  it('cash: the top wage times the shifts a day holds, the best event cash, the largest grant', () => {
    expect(cashCeilings(config)).toEqual({
      shift: { perAction: 140, perGameDay: 840 },
      event: { perAction: 30, perGameDay: 60 },
      grant: { perGrant: 100 },
    })
  })

  it('every term is max(fixture x margin, theoretical); real time bounds taps and passive time', () => {
    const { margin, maxActionsPerRealMinute, burstRealMinutes, publicCloutPerRealMinute } =
      sync.plausibility
    const theory = cloutCeilings(config)
    for (const source of ['paycheck', 'flex', 'club', 'event'] as const) {
      const ceiling = ceilings.clout[source]
      expect(ceiling.perAction).toBeGreaterThanOrEqual(theory.bySource[source]?.perAction ?? 0)
      expect(ceiling.perAction).toBeGreaterThanOrEqual(
        (baseline.clout.sources[source] ?? 0) * margin,
      )
    }
    expect(ceilings).toMatchObject({
      actionsPerRealMinute: maxActionsPerRealMinute,
      burstRealMinutes,
      publicCloutPerRealMinute,
      maxActionGameMinutes: maxActionGameMinutes(config),
      pacePerTap: {
        cash: Math.max(cashCeilings(config).shift.perAction, cashCeilings(config).event.perAction),
        clout: Math.max(
          ...(['paycheck', 'flex', 'club', 'event'] as const).map(
            (source) => theory.bySource[source]?.perAction ?? 0,
          ),
        ),
      },
      passiveGameMinutesPerRealMinute:
        config.time.gameMinutesPerRealMinute * Math.max(...config.time.speeds),
    })
    expect(ceilings.cash.perAction).toBe(Math.max(baseline.cash.maxGainPerAction * margin, 140, 30))
    expect(ceilings.cash.perGameDay).toBe(Math.max(baseline.cash.maxGainPerGameDay * margin, 900))
    expect(ceilings.grants).toEqual(grantCeilings(config))
  })

  it('a save at every list limit fits the upload size limit (grant log at 200)', () => {
    expect(config.grants.log.maxEntries).toBe(200)
    const base = initialSave(config)
    const record: GrantRecord = {
      seq: 1,
      key: goalGrantKey('reach-scene-regular', 999_999),
      kind: 'goal_reward',
      eligibility: { rule: 'goal-achieved', goalId: 'reach-scene-regular', run: 999_999 },
      reason: 'Goal reward: reach-scene-regular',
      requested: { cash: 100, clout: 25, badge: 'prestige-3' },
      cap: { cash: 100, clout: 25 },
      applied: { cash: 100, clout: 25, badge: 'prestige-3' },
      at: 999_999_999,
      issuedAtMs: MS,
      issuedBy: 'system',
      campaignId: null,
      sync: 'local',
    }
    const ledger = Array.from({ length: config.clout.ledger.maxEntries }, (_, i) => ({
      seq: 1_000_000 + i,
      at: 999_999_999,
      amount: 60,
      currency: 'cash' as const,
      source: 'flex' as const,
      ref: {
        placeId: 'coney-island-boardwalk',
        viral: true,
        placeMultiplier: 1.25,
        styleScore: 99,
        base: 20,
      },
    }))
    const big = {
      ...base,
      player: {
        ...base.player,
        clout: { ...base.player.clout, ledger },
        visited: Object.fromEntries(landmarks.map((landmark) => [landmark.id, 999_999_999])),
        inventory: {
          ...base.player.inventory,
          wearables: shopItems(config)
            .filter(isWearable)
            .map((item) => ({ itemId: item.id, acquiredMinute: 999_999_999, worn: true })),
        },
      },
      events: {
        ...base.events,
        history: Object.fromEntries(config.events.catalog.map((event) => [event.id, 999_999_999])),
      },
      grants: {
        log: Array.from({ length: config.grants.log.maxEntries }, (_, i) => ({
          ...record,
          seq: i + 1,
        })),
        nextSeq: 999_999,
      },
    }
    const bytes = new TextEncoder().encode(JSON.stringify(big)).length
    expect(bytes).toBeLessThan(sync.maxSaveBytes)
  })
})

describe('pace (DEC-19)', () => {
  const prev = lateRun()
  const keys = serverKeys(prev)
  const tapRate = sync.plausibility.maxActionsPerRealMinute

  it('counted taps beyond what the real time holds reject', () => {
    const next = later(prev)
    next.actions += tapRate * 7
    const verdict = check(prev, next, { serverGrantKeys: keys, realMinutesSinceAccept: 1 })
    expect(verdict.findings).toEqual(['action-rate'])
    expect(verdict.burstCreditMinutes).toBeNull()
  })

  it('an action count that goes back within a run rejects', () => {
    const next = later(prev)
    next.actions -= 1
    expect(check(prev, next, { serverGrantKeys: keys }).findings).toContain('regressed')
  })

  it('a clock jump no taps explain rejects; the same jump with taps for it is accepted', () => {
    const jump = 3 * 1440
    const next = later(prev, jump)
    const verdict = check(prev, next, { serverGrantKeys: keys, realMinutesSinceAccept: 1 })
    expect(verdict.findings).toContain('clock-advance')
    // Enough taps of the longest action explain the jump (rent and decay aside, which the clock
    // check does not look at).
    next.actions += Math.ceil(jump / ceilings.maxActionGameMinutes)
    const explained = check(prev, next, { serverGrantKeys: keys, realMinutesSinceAccept: 1 })
    expect(explained.findings).not.toContain('clock-advance')
  })

  it('passive time at the fastest speed is allowed for the real time', () => {
    const rate = ceilings.passiveGameMinutesPerRealMinute
    const fits = check(prev, later(prev, 10 * rate), {
      serverGrantKeys: keys,
      realMinutesSinceAccept: 10,
      burstCreditMinutes: 0,
    })
    expect(fits.findings).toEqual([])
    const over = check(prev, later(prev, 11 * rate), {
      serverGrantKeys: keys,
      realMinutesSinceAccept: 10,
      burstCreditMinutes: 0,
    })
    expect(over.findings).toEqual(['clock-advance'])
  })

  it('earnings need counted taps: cash a shift pays, with no tap counted, rejects', () => {
    const next = later(prev)
    next.player.cash += 10
    expect(check(prev, next, { serverGrantKeys: keys }).findings).toEqual(['cash-flow'])
    next.actions += 1
    expect(check(prev, next, { serverGrantKeys: keys }).findings).toEqual([])
  })
})

describe('burst credit (DEC-19, a token bucket)', () => {
  const prev = lateRun()
  const keys = serverKeys(prev)
  const burst = sync.plausibility.burstRealMinutes
  const tapRate = sync.plausibility.maxActionsPerRealMinute

  it('starts full on the first upload and refills with real time', () => {
    expect(check(null, prev, { firstUpload: true }).burstCreditMinutes).toBe(burst)
    const idle = check(prev, later(prev), {
      serverGrantKeys: keys,
      realMinutesSinceAccept: 60,
      burstCreditMinutes: 0,
    })
    expect(idle.burstCreditMinutes).toBe(burst)
  })

  it('what one upload used is gone for the next: frequent uploads never add slack', () => {
    // Each upload a minute after the last claims two minutes of taps: the first uses the credit
    // up, and the bucket never refills faster than real time.
    let base: SaveState = prev
    let credit = burst
    const findings: string[][] = []
    for (let i = 0; i < 8; i++) {
      const next = later(base)
      next.actions += tapRate * 2
      const verdict = check(base, next, {
        serverGrantKeys: keys,
        realMinutesSinceAccept: 1,
        burstCreditMinutes: credit,
      })
      findings.push([...verdict.findings])
      if (verdict.save === null) break
      base = verdict.save
      credit = verdict.burstCreditMinutes ?? credit
    }
    // 1 + 5 credit = 6 minutes: two minutes each spends one minute of credit per upload.
    expect(findings.slice(0, 5)).toEqual([[], [], [], [], []])
    expect(findings.at(-1)).toEqual(['action-rate'])
  })
})

describe('the public projection', () => {
  const premium = 'premium-probe'

  it('shows a premium cosmetic only while the server holds its entitlement', () => {
    const base = initialSave(config)
    const ledger = [
      {
        seq: 1,
        at: 0,
        amount: 10,
        currency: 'usd',
        source: 'premium',
        ref: { itemId: premium, op: 'grant' },
      },
    ]
    const save = {
      ...base,
      player: {
        ...base.player,
        clout: { ...base.player.clout, ledger, nextSeq: 2 },
      },
    }
    const without = check(null, save, { firstUpload: true })
    expect(without.publicView?.cosmetics).toEqual([])
    const entitled = check(null, save, { firstUpload: true, entitledItemIds: [premium] })
    expect(entitled.publicView?.cosmetics).toEqual([premium])
  })

  it("a grant record's sync mark is the device's bookkeeping, not part of the grant", () => {
    const { prev, next } = aroundClaim()
    const accepted = check(prev, next, { realMinutesSinceAccept: 1 })
    expect(accepted.outcome).toBe('accept')
    const synced = clone(later(next))
    synced.grants.log = synced.grants.log.map((record) => ({ ...record, sync: 'synced' }))
    const verdict = check(next, synced, { serverGrantKeys: serverKeys(next) })
    expect(verdict.findings).toEqual([])
  })
})

describe('review probes (S18c bug-hunter)', () => {
  const famous = findCloutLevel('famous', config)
  if (famous === undefined) throw new Error('no famous level')

  /** `runs` finished runs in the history, each with its own badge, ended a day apart. */
  const withHistory = (save: SaveState, runs: number): Draft<SaveState> => {
    const next = clone(save)
    next.prestige.history = Array.from({ length: runs }, (_, i) => ({
      run: i + 1,
      endedAt: (i + 1) * 1440,
      issuedAtMs: MS,
      badge: prestigeBadge(i + 1, config),
    }))
    next.prestige.count = runs
    next.prestige.badges = [...new Set(next.prestige.history.map((entry) => entry.badge))]
    next.goals.run = runs + 1
    return next
  }

  it('a forged prestige history does not lift the public level cap (clout resets each run)', () => {
    const base = initialSave(config)
    const atFamous = syncGoals(
      {
        ...base,
        clock: { minute: 60 * 1440, remainderMs: 0 },
        player: playerWithClout(base.player, famous.minClout, config),
      },
      config,
    ).save
    const plain = check(null, atFamous, { firstUpload: true, accountAgeMinutes: 0 })
    const forged = check(null, withHistory(atFamous, 40), {
      firstUpload: true,
      accountAgeMinutes: 0,
    })
    expect(forged.outcome).not.toBe('reject')
    expect(forged.publicView?.level_index).toBe(plain.publicView?.level_index)
    expect(forged.publicView?.level_index).toBeLessThan(famous.index)
  })

  it('an honest prestige uploaded a minute later is accepted', () => {
    const { before, after } = prestiged()
    const verdict = check(before, later(after), { realMinutesSinceAccept: 1 })
    expect(verdict.findings).toEqual([])
    expect(verdict.sameRun).toBe(false)
  })

  it('a prestige in the window gets no more clout per counted tap than a run does', () => {
    const { before, after } = prestiged()
    const taps = 20
    const next = clone(after)
    next.actions = taps
    next.clock.minute += taps * 1440
    next.player.clout.nextSeq += taps
    // Every tap folded away as the best flex there is, and more: far beyond a tap's worth.
    const flex = ceilings.clout.flex.perAction * taps * 3
    next.player.clout.compacted = {
      entries: next.player.clout.compacted.entries + 10_000,
      bySource: { ...next.player.clout.compacted.bySource, flex },
    }
    next.player.clout.peakLevel = playerLevel(next.player, config).index
    const verdict = check(before, next, { realMinutesSinceAccept: 1 })
    expect(verdict.findings).toContain('clout-rate')
  })

  it('a prestige in the window cannot carry legacy clout into the new run', () => {
    const { before, after } = prestiged()
    const next = clone(after)
    // Taps enough to explain a month on the clock, so the day budget is no limit.
    next.actions = 30
    next.clock.minute += 30 * 1440
    next.player.clout.compacted = {
      entries: next.player.clout.compacted.entries + 1,
      bySource: { ...next.player.clout.compacted.bySource, legacy: famous.minClout },
    }
    next.player.clout.nextSeq += 1
    next.player.clout.peakLevel = playerLevel(next.player, config).index
    const verdict = check(before, next, { realMinutesSinceAccept: 1 })
    expect(verdict.findings).toContain('clout-rate')
  })

  it('a prestige in the window gets no more cash per counted tap than a run does', () => {
    const { before, after } = prestiged()
    const next = clone(after)
    next.actions = 1
    next.clock.minute += 30 * 1440
    next.player.clout.nextSeq += 1
    next.player.cash += ceilings.cash.perAction * 5
    const verdict = check(before, next, { realMinutesSinceAccept: 1 })
    expect(verdict.findings).toContain('cash-flow')
  })

  it('folded entries are one tap each: they cannot pay every source at once', () => {
    const prev = lateRun()
    const taps = 10
    const next = later(prev)
    next.actions += taps
    next.player.clout.nextSeq += taps
    next.player.clout.compacted = {
      entries: next.player.clout.compacted.entries + taps,
      bySource: Object.fromEntries(
        Object.entries({
          ...next.player.clout.compacted.bySource,
        }).concat(
          (['flex', 'club', 'event'] as const).map((source) => [
            source,
            (next.player.clout.compacted.bySource[source] ?? 0) +
              ceilings.clout[source].perAction * taps,
          ]),
        ),
      ),
    }
    next.clock.minute += taps * 1440
    next.player.clout.peakLevel = Math.max(
      next.player.clout.peakLevel,
      playerLevel(next.player, config).index,
    )
    const verdict = check(prev, next, { serverGrantKeys: serverKeys(prev) })
    expect(verdict.findings).toContain('clout-rate')
  })

  it('an entitled premium cosmetic stays public after its ledger entry is folded away', () => {
    const premium = 'premium-probe'
    const base = initialSave(config)
    const save = clone(base)
    save.player.clout.compacted = { entries: 1, bySource: { premium: 10 } }
    save.player.clout.nextSeq = 2
    const verdict = check(null, save, { firstUpload: true, entitledItemIds: [premium] })
    expect(verdict.publicView?.cosmetics).toEqual([premium])
  })
})

describe('honest pace (DEC-19, H1)', () => {
  const empty = { cash: 0, clout: 0 }

  it('per-tap ceilings come from config (H-1R): the most one counted tap can earn', () => {
    const wage = (id: Parameters<typeof shiftWage>[0]) => shiftWage(id, config)
    const event = cashCeilings(config).event.perAction
    // Below Local, only the entry jobs: the best entry wage. From Local, junior dev too.
    expect(ceilings.cashPerTapByLevel[0]).toBe(
      Math.max(
        event,
        ...jobIds(config)
          .filter((id) => id !== 'junior-dev')
          .map(wage),
      ),
    )
    expect(ceilings.cashPerTapByLevel[1]).toBe(Math.max(event, ...jobIds(config).map(wage)))
    expect(ceilings.pacePerTap.cash).toBe(Math.max(...ceilings.cashPerTapByLevel))
  })

  it("the economy fixture's measured pace sits below the derived bound (regression guard)", () => {
    expect(baseline.pace.cashPerTap).toBeLessThanOrEqual(ceilings.pacePerTap.cash)
    expect(baseline.pace.cloutPerTap).toBeLessThanOrEqual(ceilings.pacePerTap.clout)
  })

  it('the longest action comes from config, at the worst stat penalties', () => {
    const slowest = Object.values(config.stats.atZero).reduce(
      (product, rule) => product * rule.durationMultiplier,
      1,
    )
    expect(config.actions.catalog.sleep?.durationMin).toBe(480)
    expect(maxActionGameMinutes(config)).toBe(
      Math.max(
        Math.ceil(480 * slowest),
        config.actions.maxDurationMin + transitBalance.delay.minutes.max,
      ),
    )
  })

  it('below Local, a tap earning the junior-dev wage on an empty credit is refused', () => {
    const low = economySteps.at(-1)?.save
    if (low === undefined) throw new Error('no steps')
    expect(low.player.clout.peakLevel).toBe(0)
    const next = later(low)
    next.actions += 1
    next.player.cash += ceilings.cashPerTapByLevel[0]! + 1
    const verdict = check(low, next, { serverGrantKeys: serverKeys(low), paceCredit: empty })
    expect(verdict.findings).toEqual(['honest-pace'])
    // With the credit a player carries, the same tap is fine.
    expect(check(low, next, { serverGrantKeys: serverKeys(low) }).findings).toEqual([])
  })

  it('the credit refills only by taps, and what one upload spends the next does not get back', () => {
    const low = economySteps.at(-1)?.save
    if (low === undefined) throw new Error('no steps')
    let base: SaveState = low
    let credit = ceilings.paceCreditCap
    const outcomes: string[] = []
    // A shift's top wage every tap: far above the honest pace, so the credit runs out.
    const tries = 30
    for (let i = 0; i < tries; i++) {
      const next = later(base)
      next.actions += 1
      next.player.cash += cashCeilings(config).shift.perAction
      const verdict = check(base, next, {
        serverGrantKeys: serverKeys(low),
        realMinutesSinceAccept: 1,
        paceCredit: credit,
      })
      outcomes.push(verdict.outcome)
      if (verdict.save === null || verdict.paceCredit === null) break
      base = verdict.save
      credit = verdict.paceCredit
    }
    expect(outcomes.at(-1)).toBe('reject')
    // A full credit lasts a game day's worth of top wages at most.
    const perTap = cashCeilings(config).shift.perAction - ceilings.cashPerTapByLevel[0]!
    expect(outcomes.length).toBeLessThanOrEqual(Math.ceil(ceilings.paceCreditCap.cash / perTap) + 1)
  })

  it.each([2, 10, 60])(
    'a forged Icon save on a %i-minute-old account shows no more than honest play allows',
    (minutes) => {
      const icon = findCloutLevel('icon', config)
      if (icon === undefined) throw new Error('no icon level')
      const base = initialSave(config)
      const forged = syncGoals(
        {
          ...base,
          clock: { minute: 40 * 1440, remainderMs: 0 },
          player: playerWithClout(base.player, icon.minClout * 2, config),
        },
        config,
      ).save
      const verdict = check(null, forged, { firstUpload: true, accountAgeMinutes: minutes })
      const honest = sync.plausibility.publicCloutPerRealMinute * minutes
      const allowed = cloutLevel(
        honest + ceilings.itemCloutMax + ceilings.grants.perRun.clout + ceilings.premiumCap,
        config,
      ).index
      expect(verdict.publicView?.level_index).toBeLessThanOrEqual(Math.min(allowed, icon.index - 1))
      expect(verdict.publicView?.level_id).not.toBe('icon')
    },
  )

  it('reaching Icon publicly takes at least an hour (publicCloutPerRealMinute, from config)', () => {
    const icon = findCloutLevel('icon', config)
    if (icon === undefined) throw new Error('no icon level')
    const minutes =
      (icon.minClout - ceilings.itemCloutMax) / sync.plausibility.publicCloutPerRealMinute
    expect(minutes).toBeGreaterThanOrEqual(60)
  })
})

describe('keeping one device over another (H2, branch)', () => {
  const { prev, next } = aroundClaim()

  it('a claim the server holds from the other branch is not a replay on a kept branch', () => {
    const keys = serverKeys(next)
    const replay = check(prev, next, { serverGrantKeys: keys })
    expect(replay.findings).toContain('grant-replayed')
    const branch = check(prev, next, { serverGrantKeys: keys, branch: true })
    expect(branch.outcome).toBe('accept')
    // The server keeps the row it holds; nothing is inserted twice.
    expect(branch.grantsToInsert).toEqual([])
  })

  it('a forged branch is still rejected', () => {
    const forged = clone(next)
    forged.player.cash += 100_000
    const verdict = check(prev, forged, { serverGrantKeys: serverKeys(next), branch: true })
    expect(verdict.outcome).toBe('reject')
  })
})

describe('honest-pace credit across prestige (probe)', () => {
  const { before, after } = prestiged()
  const empty = { cash: 0, clout: 0 }
  const windowCtx = (paceCredit: CashClout) => ({
    realMinutesSinceAccept: 60,
    paceCredit,
    serverGrantKeys: serverKeys(before),
  })

  it('a prestige window does not refill the credit: it carries what the new run left', () => {
    const next = clone(after)
    next.actions = 3
    next.clock.minute += 10
    const verdict = check(before, next, windowCtx(empty))
    expect(verdict.findings).toEqual([])
    expect(verdict.paceCredit?.cash).toBeCloseTo(3 * ceilings.cashPerTapByLevel[0]!)
    expect(verdict.paceCredit?.cash).toBeLessThan(ceilings.paceCreditCap.cash)
  })

  it('earnings in a new run beyond its taps at honest pace are refused, prestige or not', () => {
    const next = clone(after)
    next.actions = 2
    next.clock.minute += 10
    next.player.cash += 500
    expect(check(before, next, windowCtx(empty)).findings).toContain('honest-pace')
  })

  it('alternating a prestige window and same-run windows never earns more than the taps allow', () => {
    // Prestige window, then same-run windows: each passes on what the last one left, so the sum
    // of gains stays within the first credit plus every tap at the honest pace.
    let base: SaveState = before
    let credit: CashClout = empty
    let save = clone(after)
    save.actions = 1
    save.clock.minute += 10
    let gained = 0
    let taps = 0
    for (let i = 0; i < 12; i++) {
      const verdict = check(base, save, windowCtx(credit))
      if (verdict.save === null || verdict.paceCredit === null) break
      gained = verdict.save.player.cash - after.player.cash
      taps = verdict.save.actions
      base = verdict.save
      credit = verdict.paceCredit
      save = later(base, 10)
      save.actions += 1
      save.player.cash += Math.floor(ceilings.cashPerTapByLevel[0]! * 1.5)
    }
    // The probe ran: the prestige window and several same-run windows were accepted first.
    expect(taps).toBeGreaterThan(2)
    expect(gained).toBeLessThanOrEqual(ceilings.cashPerTapByLevel[0]! * taps + 1)
  })
})

describe('a branch without its shared save (N3)', () => {
  const { after } = prestiged()

  it('finished runs since the account save need the clout for them, counted from that save', () => {
    // The account's save: run 1, nothing earned. The upload claims a whole finished run on top.
    const head = initialSave(config)
    const verdict = check(null, after, {
      head,
      realMinutesSinceAccept: 0,
      burstCreditMinutes: 0,
      serverGrantKeys: [],
      branch: true,
    })
    expect(verdict.findings).toContain('clout-rate')
    // Counted from a save already in that run, no finished run needs clout.
    const atIcon = check(null, after, {
      head: after,
      realMinutesSinceAccept: 0,
      burstCreditMinutes: 0,
      serverGrantKeys: [],
      branch: true,
    })
    expect(atIcon.findings).not.toContain('clout-rate')
  })

  it('the grant sequence is not forward-only: each device numbers its own claims (N1)', () => {
    const { next } = aroundClaim()
    const fresh = initialSave(config)
    const verdict = check(
      null,
      { ...fresh, actions: 1 },
      {
        head: next,
        realMinutesSinceAccept: 1,
        serverGrantKeys: serverKeys(next),
        branch: true,
      },
    )
    expect(verdict.findings).not.toContain('regressed')
  })
})

describe('slice-end hunt fixes (H-4, H-5, T-1)', () => {
  it('H-4: decor from an earlier run that lost its look-only mark is marked again', () => {
    const { after } = prestiged()
    const rug = shopItems(config).find((item) => isDecor(item))
    if (rug === undefined) throw new Error('no decor')
    const next = clone(after)
    // Bought before the last prestige, but not marked as kept: its home score would count again.
    next.player.inventory.decor = [
      ...next.player.inventory.decor,
      { itemId: rug.id, acquiredMinute: 0, variant: (rug as DecorDef).decor.variants[0]?.id ?? '' },
    ]
    const verdict = check(null, next, { firstUpload: true })
    expect(verdict.repairs).toContainEqual({ kind: 'mark-kept', itemId: rug.id })
    expect(
      verdict.save?.player.inventory.decor.find((owned) => owned.itemId === rug.id)?.prestigeKept,
    ).toBe(true)
  })

  it('H-5: gifts used up are not sales: their value cannot pay for a purchase', () => {
    const prev = lateRun()
    const gift = shopItems(config).find((item) => isGift(item))
    const wearable = shopItems(config).find(
      (item) =>
        isWearable(item) && !prev.player.inventory.wearables.some((o) => o.itemId === item.id),
    )
    if (gift === undefined || wearable === undefined) throw new Error('no gift or wearable')
    const withGifts = clone(prev)
    withGifts.player.inventory.gifts = [{ itemId: gift.id, count: config.items.maxGiftStack }]
    const base = check(prev, withGifts, { serverGrantKeys: serverKeys(prev) }).save ?? prev
    // Every gift used up, a wearable bought, and cash kept as if the gifts had paid for it.
    const next = later(base)
    next.player.inventory.gifts = []
    next.player.inventory.wearables = [
      ...next.player.inventory.wearables,
      { itemId: wearable.id, acquiredMinute: next.clock.minute, worn: false },
    ]
    next.player.cash =
      base.player.cash - wearable.price + gift.sellValue * config.items.maxGiftStack
    // The used-up gifts are worth more than the wearable: the old rule let them pay for it.
    expect(gift.sellValue * config.items.maxGiftStack).toBeGreaterThan(wearable.price)
    const verdict = check(base, next, { serverGrantKeys: serverKeys(prev) })
    expect(verdict.findings).toContain('cash-flow')
  })

  it('T-1: a ledger or grant sequence at the safe-integer limit is repaired, not fatal', () => {
    const save = clone(lateRun())
    const [entry] = save.player.clout.ledger
    if (entry === undefined) throw new Error('no ledger entry')
    save.player.clout.ledger = [
      ...save.player.clout.ledger,
      { ...entry, seq: Number.MAX_SAFE_INTEGER },
    ]
    save.player.clout.nextSeq = Number.MAX_SAFE_INTEGER
    const loaded = loadSave(JSON.parse(JSON.stringify(save)), config)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(schema.safeParse(loaded.save).success).toBe(true)
    expect(loaded.save.player.clout.nextSeq).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })
})
