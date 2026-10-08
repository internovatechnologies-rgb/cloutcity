/**
 * S18c (bug-hunter fix cycle 3, F1 and F2): "keep this device" is never a way around the
 * real-time and honest-pace checks. A shared save the history no longer keeps does not switch
 * them off, and a branch starts from the shared save's stored credits, never a full bucket.
 */
import { describe, expect, it, vi } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { playerWithClout } from '@/engine/test-support'
import { grant } from '@/engine/grants'
import { syncGoals } from '@/engine/goals'
import { findCloutLevel } from '@/engine/clout'
import { SAVE_VERSION, initialSave, type SaveState } from '@/engine/save'
import { sync } from '@/lib/data/config'
import { createLogger } from '@/lib/log'
import { serverCeilings } from './ceilings'
import {
  handleUpload,
  type CommitArgs,
  type HistorySave,
  type LedgerRevision,
  type PlayerRecord,
  type SaveBackend,
  type StoredSave,
} from './handleUpload'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const USER = '00000000-0000-4000-8000-000000000001'
const DEVICE = '00000000-0000-4000-8000-0000000000d1'
const logger = createLogger({ sink: () => {} })

/** A backend that behaves like commit_save: it stores what it accepts, credits included. */
function liveBackend(
  start: StoredSave,
  ageMinutes: number,
  grantKeys: string[] = [],
  withBaselines = true,
) {
  let save: StoredSave = start
  let now = NOW
  const history = new Map<number, HistorySave>()
  // Like the revision ledger: every accepted revision, never trimmed here.
  const ledger = new Map<number, LedgerRevision>()
  const remember = (revision: number, entry: HistorySave) => {
    history.set(revision, entry)
    const data = entry.data as SaveState
    ledger.set(revision, {
      acceptedAt: entry.acceptedAt,
      burstCreditMinutes: entry.burstCreditMinutes,
      paceCredit: entry.paceCredit,
      baseline: withBaselines
        ? {
            actions: data.actions,
            minute: data.clock.minute,
            run: data.goals.run,
            prestigeCount: data.prestige.count,
          }
        : null,
    })
    // Like commit_save, the full history keeps only the newest sync.json historyKeep saves.
    for (const old of [...history.keys()].sort((a, b) => a - b)) {
      if (history.size <= sync.historyKeep) break
      history.delete(old)
    }
  }
  remember(start.revision, {
    saveVersion: start.saveVersion,
    data: start.data,
    acceptedAt: start.acceptedAt ?? new Date(NOW).toISOString(),
    burstCreditMinutes: start.burstCreditMinutes,
    paceCredit: start.paceCredit,
  })
  const commits: CommitArgs[] = []
  const backend: SaveBackend = {
    userIdFor: vi.fn(async () => USER),
    load: vi.fn(async (): Promise<PlayerRecord> => ({
      attested: true,
      createdAt: new Date(NOW - ageMinutes * 60_000).toISOString(),
      save,
      grantKeys,
      entitledItemIds: [],
    })),
    saveAt: vi.fn(async (_u: string, revision: number) => history.get(revision) ?? null),
    ledgerAt: vi.fn(async (_u: string, revision: number) => ledger.get(revision) ?? null),
    consumeOverride: vi.fn(async () => 'ok' as const),
    commit: vi.fn(async (args: CommitArgs) => {
      commits.push(args)
      const acceptedAt = new Date(now).toISOString()
      save = {
        revision: args.expectedRevision + 1,
        saveVersion: args.saveVersion,
        data: args.data,
        acceptedAt,
        deviceId: args.deviceId,
        burstCreditMinutes: args.burstCreditMinutes,
        paceCredit: args.paceCredit,
      }
      // Like commit_save, the history row keeps the credits the save was stored with (F2).
      remember(save.revision, {
        saveVersion: args.saveVersion,
        data: args.data,
        acceptedAt,
        burstCreditMinutes: args.burstCreditMinutes,
        paceCredit: args.paceCredit,
      })
      return { ok: true as const, revision: save.revision, acceptedAt }
    }),
    quarantine: vi.fn(async () => 'ok' as const),
  }
  return {
    backend,
    commits,
    head: () => save,
    tick: (ms: number) => (now += ms),
    now: () => now,
  }
}

const body = (save: unknown, patch: Record<string, unknown>) =>
  JSON.stringify({
    saveVersion: SAVE_VERSION,
    deviceId: DEVICE,
    clientSavedAt: NOW,
    save,
    ...patch,
  })

/** An account mid-run: the pace credit used up, accepted 10 seconds ago. */
function midRun(): StoredSave {
  const base = initialSave(config)
  const save: SaveState = { ...base, clock: { minute: 2 * 1440, remainderMs: 0 }, actions: 50 }
  return {
    revision: 10,
    saveVersion: SAVE_VERSION,
    data: save,
    acceptedAt: new Date(NOW - 10_000).toISOString(),
    deviceId: DEVICE,
    burstCreditMinutes: 0,
    paceCredit: { cash: 0, clout: 0 },
  }
}

/** Ten game days of cash in one tap, ten seconds after the last accept. */
function forged(from: SaveState): SaveState {
  return {
    ...from,
    actions: from.actions + 1,
    clock: { ...from.clock, minute: from.clock.minute + 10 * 1440 },
    player: { ...from.player, cash: from.player.cash + 5000 },
  }
}

describe('keep this device is no bypass (F1, F2)', () => {
  it('baseline: the forged window is rejected as a plain upload', async () => {
    const live = liveBackend(midRun(), 24 * 60)
    const save = live.head().data as SaveState
    const result = await handleUpload(
      { authorization: 'Bearer x', bodyText: body(forged(save), { baseRevision: 10 }) },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(result.status).toBe(422)
  })

  it('overrideFromRevision: 0 (never in the history) must not switch off real-time checks', async () => {
    const live = liveBackend(midRun(), 24 * 60)
    const save = live.head().data as SaveState
    const result = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body(forged(save), { baseRevision: 10, overrideFromRevision: 0 }),
      },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(result.status).toBe(422)
  })

  it('the pace credit is refilled only by taps, never by an upload pattern', async () => {
    // A no-op upload, then a "keep this device" branching off the save before it: full credit.
    const live = liveBackend(midRun(), 24 * 60)
    const start = live.head().data as SaveState
    live.tick(6_000)
    const dummy = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body(
          { ...start, clock: { ...start.clock, minute: start.clock.minute + 1 } },
          {
            baseRevision: 10,
          },
        ),
      },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(dummy.status).toBe(200)
    expect(live.head().paceCredit).toEqual({ cash: 0, clout: 0 })
    live.tick(6_000)
    // Six top-wage shifts (within every per-tap and per-day ceiling), far above honest pace.
    const taps = 6
    const gain = 140 * taps
    const greedy: SaveState = {
      ...start,
      actions: start.actions + taps,
      clock: { ...start.clock, minute: start.clock.minute + 600 },
      player: { ...start.player, cash: start.player.cash + gain },
    }
    const branched = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body(greedy, { baseRevision: 11, overrideFromRevision: 10 }),
      },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    // Control: the same upload as a plain one (no branch) is refused on the empty credit.
    expect(branched.status).toBe(422)
  })

  it('control: six top-wage shifts on an empty credit, plain upload, is refused', async () => {
    const live = liveBackend(midRun(), 24 * 60)
    const start = live.head().data as SaveState
    live.tick(12_000)
    const greedy: SaveState = {
      ...start,
      actions: start.actions + 6,
      clock: { ...start.clock, minute: start.clock.minute + 600 },
      player: { ...start.player, cash: start.player.cash + 840 },
    }
    const plain = await handleUpload(
      { authorization: 'Bearer x', bodyText: body(greedy, { baseRevision: 10 }) },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(plain.status).toBe(422)
  })

  it('the public Icon floor stays at least an hour (publicCloutPerRealMinute)', () => {
    const c = serverCeilings()
    const icon = findCloutLevel('icon', config)
    if (icon === undefined) throw new Error('no icon')
    const perMinute = sync.plausibility.publicCloutPerRealMinute
    expect((icon.minClout - c.itemCloutMax) / perMinute).toBeGreaterThanOrEqual(60)
  })
})

/**
 * Device X (the account's save) reached Local and claimed its reward. Device Y never synced (or
 * its shared save was trimmed): it played the same start offline, a few honest taps, no claim.
 * (Bug-hunter fix cycle 4 repro.)
 */
function scenario() {
  const fresh = initialSave(config)
  const local = syncGoals(
    { ...fresh, player: playerWithClout(fresh.player, 150, config) },
    config,
  ).save
  const claimed = grant(
    local,
    { kind: 'goal_reward', goalId: 'reach-local', reward: { cash: 50, clout: 15 } },
    NOW,
    config,
  )
  if (!claimed.ok) throw new Error(claimed.error.code)
  const headSave: SaveState = { ...claimed.save, actions: 40 }
  const stored: StoredSave = {
    revision: 12,
    saveVersion: SAVE_VERSION,
    data: headSave,
    acceptedAt: new Date(NOW - 60_000).toISOString(),
    deviceId: DEVICE,
    burstCreditMinutes: 5,
    paceCredit: serverCeilings().paceCreditCap,
  }
  const mine: SaveState = {
    ...fresh,
    actions: 10,
    clock: { ...fresh.clock, minute: fresh.clock.minute + 120 },
    player: { ...fresh.player, cash: fresh.player.cash + 20 },
  }
  return { stored, mine, keys: claimed.save.grants.log.map((record) => record.key) }
}

const findingsOf = (backend: SaveBackend) =>
  (backend.quarantine as unknown as { mock: { calls: { findings: string[] }[][] } }).mock.calls.at(
    -1,
  )?.[0]?.findings

describe('an honest kept game behind the account (N1-N3)', () => {
  it.each([0, 7])(
    'Y keeps its own game (overrideFromRevision %i, not in the history): accepted',
    async (override) => {
      const { stored, mine, keys } = scenario()
      const live = liveBackend(stored, 3 * 60, keys)
      const result = await handleUpload(
        {
          authorization: 'Bearer x',
          bodyText: body(mine, { baseRevision: 12, overrideFromRevision: override }),
        },
        live.backend,
        serverCeilings(),
        live.now(),
        logger,
      )
      expect({ status: result.status, findings: findingsOf(live.backend) }).toEqual({
        status: 200,
        findings: undefined,
      })
    },
  )

  it('the same kept game with a shared save the history keeps: accepted (control)', async () => {
    const { stored, mine, keys } = scenario()
    const live = liveBackend(stored, 3 * 60, keys)
    const fresh = initialSave(config)
    vi.mocked(live.backend.saveAt).mockImplementation(async (_u: string, r: number) =>
      r === 7
        ? {
            saveVersion: SAVE_VERSION,
            data: fresh,
            acceptedAt: new Date(NOW - 30 * 60_000).toISOString(),
            burstCreditMinutes: 5,
            paceCredit: serverCeilings().paceCreditCap,
          }
        : null,
    )
    const result = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body(mine, { baseRevision: 12, overrideFromRevision: 7 }),
      },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(result.status).toBe(200)
  })

  it('a kept branch cannot claim again a reward the account already received', async () => {
    const { stored, mine, keys } = scenario()
    const live = liveBackend(stored, 3 * 60, keys)
    const kept = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body(mine, { baseRevision: 12, overrideFromRevision: 0 }),
      },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(kept.status).toBe(200)
    // Back on the kept game, the player claims the Local reward the account already received.
    const reached = syncGoals(
      { ...mine, player: playerWithClout(mine.player, 150, config) },
      config,
    ).save
    const again = grant(
      reached,
      { kind: 'goal_reward', goalId: 'reach-local', reward: { cash: 50, clout: 15 } },
      NOW,
      config,
    )
    if (!again.ok) throw new Error(again.error.code)
    live.tick(60_000)
    const replay = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body({ ...again.save, actions: mine.actions + 1 }, { baseRevision: 13 }),
      },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(replay.status).toBe(422)
    expect(findingsOf(live.backend)).toContain('grant-replayed')
  })

  it("a kept game from before the account's last prestige is refused plainly (N2)", async () => {
    const { stored, mine, keys } = scenario()
    const head = stored.data as SaveState
    const prestigedHead: SaveState = {
      ...head,
      goals: {
        ...head.goals,
        run: 2,
        achieved: {},
        icon: { reachedAt: null, acknowledged: false },
      },
      prestige: {
        count: 1,
        badges: ['prestige-1'],
        history: [{ run: 1, endedAt: head.clock.minute, issuedAtMs: NOW, badge: 'prestige-1' }],
      },
    }
    const live = liveBackend({ ...stored, data: prestigedHead }, 3 * 60, keys)
    const result = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body(mine, { baseRevision: 12, overrideFromRevision: 0 }),
      },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(result).toEqual({ status: 409, body: { ok: false, code: 'branch-behind' } })
    expect(live.backend.quarantine).not.toHaveBeenCalled()
    expect(live.commits).toEqual([])
  })

  it('override 0 (a revision no ledger knows): lenient by design, bounded by the account age', async () => {
    const { stored, mine, keys } = scenario()
    const live = liveBackend(stored, 3 * 60, keys)
    // The account is three hours old, with 5 minutes of burst on its save: 185 minutes of taps.
    const busy = { ...mine, actions: 185 * serverCeilings().actionsPerRealMinute + 10 }
    const result = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body(busy, { baseRevision: 12, overrideFromRevision: 0 }),
      },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(result.status).toBe(422)
    expect(findingsOf(live.backend)).toContain('action-rate')
  })
})

describe('keep this device from a revision the history trimmed: the revision ledger (N3)', () => {
  /** Both devices synced revision 10; then device X uploads six more times (the history keeps five). */
  async function trimmed() {
    const base = initialSave(config)
    const shared: SaveState = { ...base, actions: 20, clock: { minute: 1440, remainderMs: 0 } }
    const live = liveBackend(
      {
        revision: 10,
        saveVersion: SAVE_VERSION,
        data: shared,
        acceptedAt: new Date(NOW).toISOString(),
        deviceId: DEVICE,
        burstCreditMinutes: 5,
        paceCredit: serverCeilings().paceCreditCap,
      },
      24 * 60,
    )
    let save = shared
    for (let revision = 10; revision < 16; revision++) {
      live.tick(60_000)
      save = { ...save, clock: { ...save.clock, minute: save.clock.minute + 10 } }
      const result = await handleUpload(
        { authorization: 'Bearer x', bodyText: body(save, { baseRevision: revision }) },
        live.backend,
        serverCeilings(),
        live.now(),
        logger,
      )
      expect(result.status).toBe(200)
    }
    expect(await live.backend.saveAt(USER, 10)).toBeNull()
    expect(await live.backend.ledgerAt(USER, 10)).not.toBeNull()
    return { live, shared }
  }

  it('an honest device that played three game days offline keeps its game: accepted', async () => {
    const { live, shared } = await trimmed()
    // Three hours of real play since revision 10: 120 taps, three game days, a little cash.
    live.tick(3 * 3_600_000)
    const offline: SaveState = {
      ...shared,
      actions: shared.actions + 120,
      clock: { ...shared.clock, minute: shared.clock.minute + 3 * 1440 },
      player: { ...shared.player, cash: shared.player.cash + 150 },
    }
    const result = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body(offline, { baseRevision: 16, overrideFromRevision: 10 }),
      },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(result).toMatchObject({ status: 200, body: { ok: true, revision: 17 } })
  })

  it("a branch forged from the oldest revision gets no more than that revision's time and credit", async () => {
    const { live, shared } = await trimmed()
    live.tick(3 * 3_600_000)
    const minutes = 3 * 60 + 6 + 5 // since revision 10, plus its burst credit
    const ceilings = serverCeilings()
    const tooManyTaps: SaveState = {
      ...shared,
      actions: shared.actions + Math.ceil(minutes * ceilings.actionsPerRealMinute) + 1,
    }
    const taps = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body(tooManyTaps, { baseRevision: 16, overrideFromRevision: 10 }),
      },
      live.backend,
      ceilings,
      live.now(),
      logger,
    )
    expect(taps.status).toBe(422)
    const greedy: SaveState = {
      ...shared,
      actions: shared.actions + 10,
      player: {
        ...shared.player,
        cash:
          shared.player.cash +
          // The whole run's taps at honest pace (the branch is a whole run), plus the credit.
          Math.ceil(
            ceilings.paceCreditCap.cash + ceilings.pacePerTap.cash * (shared.actions + 10),
          ) +
          1,
      },
    }
    const cash = await handleUpload(
      {
        authorization: 'Bearer x',
        bodyText: body(greedy, { baseRevision: 16, overrideFromRevision: 10 }),
      },
      live.backend,
      ceilings,
      live.now(),
      logger,
    )
    expect(cash.status).toBe(422)
  })
})

/**
 * A long honest run on both devices: 2000 taps and 20 game days when they last shared revision
 * 10. Device X then uploads six times in six minutes (history trims 10). Device Y played 20 more
 * taps offline for 10 real minutes and keeps its game.
 */
async function longRunTrimmed(idleDays = 0, withBaselines = true) {
  const base = initialSave(config)
  const shared: SaveState = {
    ...base,
    actions: 2000,
    clock: { minute: (20 + idleDays) * 1440, remainderMs: 0 },
  }
  const live = liveBackend(
    {
      revision: 10,
      saveVersion: SAVE_VERSION,
      data: shared,
      acceptedAt: new Date(NOW).toISOString(),
      deviceId: DEVICE,
      burstCreditMinutes: 5,
      paceCredit: serverCeilings().paceCreditCap,
    },
    7 * 24 * 60,
    [],
    withBaselines,
  )
  let save = shared
  for (let revision = 10; revision < 16; revision++) {
    live.tick(60_000)
    save = {
      ...save,
      actions: save.actions + 1,
      clock: { ...save.clock, minute: save.clock.minute + 30 },
    }
    const r = await handleUpload(
      { authorization: 'Bearer x', bodyText: body(save, { baseRevision: revision }) },
      live.backend,
      serverCeilings(),
      live.now(),
      logger,
    )
    expect(r.status).toBe(200)
  }
  expect(await live.backend.saveAt(USER, 10)).toBeNull()
  live.tick(4 * 60_000)
  const mine: SaveState = {
    ...shared,
    actions: shared.actions + 20,
    clock: { ...shared.clock, minute: shared.clock.minute + 300 },
  }
  return { live, mine, shared }
}

const keep = (
  live: Awaited<ReturnType<typeof longRunTrimmed>>['live'],
  save: SaveState,
  from: number,
) =>
  handleUpload(
    {
      authorization: 'Bearer x',
      bodyText: body(save, { baseRevision: 16, overrideFromRevision: from }),
    },
    live.backend,
    serverCeilings(),
    live.now(),
    logger,
  )

describe('keep this device from a trimmed revision: the ledger baselines (R1)', () => {
  it('an honest long run kept from a trimmed revision is accepted', async () => {
    const { live, mine } = await longRunTrimmed()
    const result = await keep(live, mine, 10)
    expect({ status: result.status, findings: findingsOf(live.backend) }).toEqual({
      status: 200,
      findings: undefined,
    })
  })

  it('control: the same game with override 0 (account age) is accepted', async () => {
    const { live, mine } = await longRunTrimmed()
    const result = await keep(live, mine, 0)
    expect({ status: result.status, findings: findingsOf(live.backend) }).toEqual({
      status: 200,
      findings: undefined,
    })
  })

  it('more taps above the baseline than the time since the revision allows is refused', async () => {
    const { live, mine, shared } = await longRunTrimmed()
    // Revision 10 was accepted 10 minutes ago, with 5 minutes of burst: 15 minutes of taps.
    const forged = {
      ...mine,
      actions: shared.actions + 15 * serverCeilings().actionsPerRealMinute + 1,
    }
    const result = await keep(live, forged, 10)
    expect(result.status).toBe(422)
    expect(findingsOf(live.backend)).toContain('action-rate')
  })

  it('without baselines (an old ledger row) the whole run is measured from the account age', async () => {
    const { live, mine } = await longRunTrimmed(0, false)
    expect((await live.backend.ledgerAt(USER, 10))?.baseline).toBeNull()
    expect((await keep(live, mine, 10)).status).toBe(200)
    // Account age (a week) is the budget: past it, refused.
    const other = await longRunTrimmed(0, false)
    const forged = {
      ...other.mine,
      actions: other.shared.actions + 7 * 24 * 60 * serverCeilings().actionsPerRealMinute,
    }
    expect((await keep(other.live, forged, 10)).status).toBe(422)
  })

  it('a kept game in another run than the revision falls back to the account-age path', async () => {
    const { live, shared } = await longRunTrimmed()
    // Device Y finished the run and started run 2 offline: 30 taps in the new run, below the
    // revision's 2000. Measured from that baseline it would read as going back.
    const nextRun: SaveState = {
      ...shared,
      actions: 30,
      clock: { ...shared.clock, minute: shared.clock.minute + 600 },
      goals: { ...shared.goals, run: 2, achieved: {} },
      prestige: {
        count: 1,
        badges: ['prestige-1'],
        history: [
          { run: 1, endedAt: shared.clock.minute + 60, issuedAtMs: NOW, badge: 'prestige-1' },
        ],
      },
    }
    const result = await keep(live, nextRun, 10)
    expect(findingsOf(live.backend) ?? []).not.toContain('regressed')
    expect(findingsOf(live.backend) ?? []).not.toContain('action-rate')
    expect(result.status).toBe(200)
  })
})

describe('HUNT cycle 6: baseline abuse', () => {
  it('a kept game behind its baseline in taps is refused (regressed)', async () => {
    const { live, mine, shared } = await longRunTrimmed()
    const result = await keep(live, { ...mine, actions: shared.actions - 500 }, 10)
    expect(result.status).toBe(422)
    expect(findingsOf(live.backend)).toContain('regressed')
  })

  it('a kept game behind its baseline in clock is refused (regressed)', async () => {
    const { live, mine, shared } = await longRunTrimmed()
    const back = { ...mine, clock: { ...mine.clock, minute: shared.clock.minute - 600 } }
    const result = await keep(live, back, 10)
    expect(result.status).toBe(422)
    expect(findingsOf(live.backend)).toContain('regressed')
  })

  it('a prestige count that does not match its run (to dodge the baseline) is refused', async () => {
    const { live, mine } = await longRunTrimmed()
    const forged = {
      ...mine,
      actions: mine.actions + 100_000,
      prestige: { ...mine.prestige, count: 1 },
    }
    const result = await keep(live, forged, 10)
    expect(result.status).not.toBe(200)
  })

  it('a forged run 2 without a whole prestige history (to take the lenient path) is refused', async () => {
    const { live, mine } = await longRunTrimmed()
    const forged = { ...mine, goals: { ...mine.goals, run: 2 } }
    const result = await keep(live, forged, 10)
    expect(result.status).not.toBe(200)
  })
})
