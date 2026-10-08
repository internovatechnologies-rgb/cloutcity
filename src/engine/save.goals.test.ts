/** Save v8 (S15): visits, goals, the grant log and prestige; migration from v7 and repairs. */
import { describe, expect, it } from 'vitest'
import { appendClout } from './clout'
import { engineConfig as config } from './config'
import { initialGoalsState, syncGoals } from './goals'
import { grant, initialGrantsState, type GrantRecord } from './grants'
import { initialPrestigeState, prestige } from './prestige'
import {
  SAVE_VERSION,
  createSaveSchema,
  initialSave,
  loadSave,
  migrateSave,
  type SaveState,
} from './save'
import { playerWithClout } from './test-support'

const schema = createSaveSchema(config)
const NOW = 20_000
const MS = 1_760_000_000_000
const base: SaveState = { ...initialSave(config), clock: { minute: NOW, remainderMs: 0 } }

/** `base` as a v7 save: no visits, goals, grants or prestige. */
function v7(save: SaveState = base): Record<string, unknown> {
  const player: Record<string, unknown> = { ...save.player }
  delete player.visited
  const out: Record<string, unknown> = { ...save, player }
  delete out.goals
  delete out.grants
  delete out.prestige
  delete out.actions
  return out
}

/** A v8 save with two claimed rewards (first paycheck, Local) at 120 earned clout. */
function claimedSave(): SaveState {
  let save = syncGoals(
    {
      ...base,
      player: {
        ...playerWithClout(base.player, 120, config),
        clout: { ...playerWithClout(base.player, 120, config).clout, firstPaycheckPaid: true },
      },
    },
    config,
  ).save
  for (const [goalId, reward] of [
    ['first-paycheck', { cash: 25, clout: 5 }],
    ['reach-local', { cash: 50, clout: 15 }],
  ] as const) {
    const result = grant(save, { kind: 'goal_reward', goalId, reward }, MS, config)
    if (!result.ok) throw new Error(result.error.code)
    save = result.save
  }
  return save
}

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

describe('save v8', () => {
  it('is version 11 (S18c after S08), and a fresh save has no visits, goals, grants or prestige', () => {
    expect(SAVE_VERSION).toBe(11)
    const fresh = initialSave(config)
    expect(fresh.player.visited).toEqual({})
    expect(fresh.goals).toEqual(initialGoalsState)
    expect(fresh.grants).toEqual(initialGrantsState)
    expect(fresh.prestige).toEqual(initialPrestigeState)
    expect(schema.safeParse(fresh).success).toBe(true)
  })

  it('round-trips claimed rewards and a prestige untouched', () => {
    const icon = syncGoals(
      { ...claimedSave(), player: playerWithClout(claimedSave().player, 5000, config) },
      config,
    ).save
    const done = prestige(icon, MS, config)
    if (!done.ok) throw new Error(done.error.code)
    for (const save of [claimedSave(), done.save]) {
      expect(schema.safeParse(save).success).toBe(true)
      expect(loadSave(roundTrip(save), config)).toEqual({ ok: true, save, repaired: [] })
    }
  })
})

describe('v7 -> v8', () => {
  it('keeps everything and derives the goals already reached at the current minute', () => {
    const progressed: SaveState = {
      ...base,
      player: {
        ...playerWithClout(base.player, 320, config),
        clubNights: { [Object.keys(config.place.clubs)[0] ?? 'missing']: 10 },
      },
    }
    const migrated = migrateSave(roundTrip(v7(progressed)), 7, config)
    expect(migrated.outcome).toBe('carried')
    expect(migrated.save.player).toEqual({ ...progressed.player, visited: {} })
    expect(migrated.save.goals).toEqual({
      run: 1,
      achieved: { 'first-club-night': NOW, 'reach-local': NOW, 'reach-scene-regular': NOW },
      icon: { reachedAt: null, acknowledged: false },
    })
    expect(migrated.save.grants).toEqual(initialGrantsState)
    expect(migrated.save.prestige).toEqual(initialPrestigeState)
    expect(schema.safeParse(migrated.save).success).toBe(true)
  })

  it('a save already at Icon starts with an unacknowledged Icon moment', () => {
    const icon = { ...base, player: playerWithClout(base.player, 6000, config) }
    const { save } = migrateSave(roundTrip(v7(icon)), 7, config)
    expect(save.goals.achieved['reach-icon']).toBe(NOW)
    expect(save.goals.icon).toEqual({ reachedAt: NOW, acknowledged: false })
  })

  it('every version v1 to v8 loads into the current form', () => {
    const saves: [number, unknown][] = [
      [1, { player: { cash: 1 } }],
      [2, { clock: base.clock, player: { cash: 2, stats: base.player.stats }, speed: 1 }],
      [7, v7()],
    ]
    for (const [version, persisted] of saves) {
      const migrated = migrateSave(roundTrip(persisted), version, config)
      expect(migrated.outcome, `v${version}`).toBe('carried')
      expect(schema.safeParse(migrated.save).success, `v${version}`).toBe(true)
    }
    expect(loadSave(roundTrip(claimedSave()), config).ok).toBe(true)
  })

  it('a v7 save with structural damage starts fresh; a newer save is refused', () => {
    expect(migrateSave({ ...v7(), admin: true }, 7, config).outcome).toBe('fresh')
    expect(() => migrateSave(v7(), SAVE_VERSION + 1, config)).toThrow(/newer/)
  })
})

describe('v8 repairs', () => {
  const claimed = claimedSave()
  const records = claimed.grants.log
  const [paycheck, local] = records as [GrantRecord, GrantRecord]

  const load = (patch: Partial<Record<keyof SaveState, unknown>>, player?: object) => {
    const raw = roundTrip({
      ...claimed,
      ...patch,
      player: { ...claimed.player, ...player },
    })
    const result = loadSave(raw, config)
    if (!result.ok) throw new Error(`unusable: ${result.issues.join(', ')}`)
    expect(schema.safeParse(result.save).success).toBe(true)
    return result
  }

  it.each<[string, unknown, readonly string[]]>([
    ['a malformed record', [paycheck, { ...local, applied: 'lots' }], ['goal:first-paycheck:r1']],
    [
      'a record granted in the future',
      [paycheck, { ...local, at: NOW + 1 }],
      ['goal:first-paycheck:r1'],
    ],
    [
      'a duplicate key',
      [paycheck, { ...local, key: paycheck.key, seq: 9 }],
      ['goal:first-paycheck:r1'],
    ],
    ['records out of order', [local, paycheck], ['goal:reach-local:r1']],
    [
      'a record whose key does not match its eligibility',
      [paycheck, { ...local, key: 'goal:reach-icon:r1' }],
      ['goal:first-paycheck:r1'],
    ],
    [
      'a record that applied more than its cap',
      [paycheck, { ...local, applied: { ...local.applied, cash: local.cap.cash + 1 } }],
      ['goal:first-paycheck:r1'],
    ],
  ])('drops %s and keeps the rest of the log', (_label, log, keys) => {
    const result = load({ grants: { log, nextSeq: 3 } })
    expect(result.repaired).toEqual(['grants'])
    expect(result.save.grants.log.map((record) => record.key)).toEqual(keys)
  })

  it('a dropped record stays claimed through the clout ledger: no second claim', () => {
    const result = load({ grants: { log: [paycheck], nextSeq: 3 } })
    const again = grant(
      result.save,
      { kind: 'goal_reward', goalId: 'reach-local', reward: { cash: 50, clout: 15 } },
      MS,
      config,
    )
    expect(again).toEqual({ ok: false, error: { code: 'INELIGIBLE', reason: 'already-claimed' } })
  })

  it('moves nextSeq past the log', () => {
    const result = load({ grants: { log: records, nextSeq: 1 } })
    expect(result.save.grants.nextSeq).toBe(3)
  })

  it('drops unknown, coming-soon and future goals, and clamps the run up to its claimed keys', () => {
    const result = load({
      goals: {
        run: 0,
        achieved: {
          'first-paycheck': NOW,
          'made-up-goal': 1,
          'first-friend': 2,
          'reach-local': NOW + 5,
          'first-outfit': -3,
        },
        icon: { reachedAt: null, acknowledged: false },
      },
    })
    expect(result.repaired).toEqual(['goals'])
    expect(result.save.goals).toEqual({
      run: 1,
      achieved: { 'first-paycheck': NOW },
      icon: { reachedAt: null, acknowledged: false },
    })
  })

  it('a run behind a claimed key moves up to it', () => {
    const later = {
      ...paycheck,
      key: 'goal:first-paycheck:r4',
      eligibility: { ...paycheck.eligibility, run: 4 },
    }
    const result = load({
      grants: { log: [later], nextSeq: 2 },
      goals: { ...claimed.goals, run: 2 },
    })
    expect(result.save.goals.run).toBe(4)
  })

  it('an Icon moment out of step with the victory goal follows the goal', () => {
    const icon = syncGoals(
      { ...claimed, player: playerWithClout(claimed.player, 5000, config) },
      config,
    ).save
    const mismatched = load(
      { ...icon, goals: { ...icon.goals, icon: { reachedAt: 7, acknowledged: true } } },
      icon.player,
    )
    expect(mismatched.save.goals.icon).toEqual({ reachedAt: NOW, acknowledged: false })
    const phantom = load({
      goals: { ...claimed.goals, icon: { reachedAt: NOW, acknowledged: true } },
    })
    expect(phantom.save.goals.icon).toEqual({ reachedAt: null, acknowledged: false })
  })

  it('drops unknown and repeated badges and broken history; the count covers the history', () => {
    const run = { run: 1, endedAt: 10, issuedAtMs: MS, badge: 'prestige-1' }
    const result = load({
      prestige: {
        count: 0,
        badges: ['prestige-1', 'gold-crown', 'prestige-1'],
        history: [run, { ...run, badge: 'gold-crown' }, { ...run, endedAt: NOW + 1 }],
      },
    })
    expect(result.repaired).toEqual(['prestige'])
    expect(result.save.prestige).toEqual({ count: 1, badges: ['prestige-1'], history: [run] })
  })

  it('drops visits to unknown places, memorials and future minutes', () => {
    const result = load(
      {},
      {
        visited: {
          'brooklyn-bridge': 5,
          'nowhere-landmark': 6,
          'september-11-memorial': 7,
          'central-park': NOW + 1,
        },
      },
    )
    expect(result.repaired).toEqual(['player.visited'])
    expect(result.save.player.visited).toEqual({ 'brooklyn-bridge': 5 })
  })

  it.each([null, 'junk', 7, []])('replaces unusable S15 state (%j) with fresh state', (junk) => {
    const result = load({ goals: junk, grants: junk, prestige: junk }, { visited: junk })
    expect(result.repaired).toEqual(['player.visited', 'grants', 'goals', 'prestige'])
    expect(result.save.prestige).toEqual(initialPrestigeState)
    // The claims still hold: the ledger remembers them, and the run cannot fall behind.
    expect(result.save.goals.run).toBe(1)
    expect(result.save.grants).toEqual(initialGrantsState)
  })

  it('a ledger grant entry alone keeps its key claimed after the log is lost', () => {
    const ledgerOnly = appendClout(
      base.player.clout,
      { source: 'grant', amount: 3, ref: { grantKey: 'goal:reach-local:r3' } },
      NOW,
      config,
    ).state
    const result = loadSave(
      roundTrip({ ...base, player: { ...base.player, clout: ledgerOnly } }),
      config,
    )
    if (!result.ok) throw new Error('unusable')
    expect(result.save.goals.run).toBe(3)
    expect(result.repaired).toEqual(['goals'])
  })
})

describe('kept looks in the save (S15, Q-8)', () => {
  const tee = { itemId: 'bodega-graphic-tee', acquiredMinute: 10, worn: true }

  it('round-trips a kept look untouched', () => {
    const save = {
      ...base,
      player: {
        ...base.player,
        inventory: {
          wearables: [{ ...tee, prestigeKept: true }],
          gifts: [],
          outfit: { top: tee.itemId },
          decor: [],
        },
      },
    }
    expect(createSaveSchema(config).safeParse(save).success).toBe(true)
    expect(loadSave(JSON.parse(JSON.stringify(save)), config)).toMatchObject({
      ok: true,
      repaired: [],
    })
  })

  it.each([false, 'yes', 1, null])(
    'a damaged mark (%j) stays a kept look; unknown items are dropped',
    (mark) => {
      const raw = JSON.parse(
        JSON.stringify({
          ...base,
          player: {
            ...base.player,
            inventory: {
              wearables: [
                { ...tee, prestigeKept: mark },
                { itemId: 'made-up-hat', acquiredMinute: 1, worn: true, prestigeKept: true },
              ],
              gifts: [],
              outfit: {},
            },
          },
        }),
      ) as unknown
      const result = loadSave(raw, config)
      if (!result.ok) throw new Error('unusable')
      expect(result.repaired).toEqual(['player.inventory'])
      expect(result.save.player.inventory.wearables).toEqual([{ ...tee, prestigeKept: true }])
    },
  )
})
