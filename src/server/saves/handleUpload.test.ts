/**
 * POST /api/save's rules (S18c) against an in-memory backend: authentication, body and size
 * checks, the attestation, the save format, the revision, plausibility, and what reaches
 * commit_save and quarantine_save. tests/integration/save-sync.test.ts runs the real database.
 */
import { describe, expect, it, vi } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { syncGoals } from '@/engine/goals'
import { grant } from '@/engine/grants'
import { SAVE_VERSION, initialSave, type SaveState } from '@/engine/save'
import { playerWithClout } from '@/engine/test-support'
import { sync } from '@/lib/data/config'
import { createLogger } from '@/lib/log'
import { serverCeilings } from './ceilings'
import {
  handleUpload,
  type CommitArgs,
  type CommitOutcome,
  type HistorySave,
  type PlayerRecord,
  type QuarantineArgs,
  type SaveBackend,
  type StoredSave,
} from './handleUpload'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const USER = '00000000-0000-4000-8000-000000000001'
const DEVICE = '00000000-0000-4000-8000-0000000000d1'
const logger = createLogger({ sink: () => {} })

function fakeBackend(record: Partial<PlayerRecord> | null = {}) {
  const commits: CommitArgs[] = []
  const quarantined: QuarantineArgs[] = []
  let outcome: CommitOutcome | null = null
  const history = new Map<number, HistorySave>()
  let overrides = 0
  const player: PlayerRecord | null =
    record === null
      ? null
      : {
          attested: true,
          createdAt: new Date(NOW - 24 * 3_600_000).toISOString(),
          save: null,
          grantKeys: [],
          entitledItemIds: [],
          ...record,
        }
  const backend: SaveBackend = {
    userIdFor: vi.fn(async (token: string) => (token === 'good' ? USER : null)),
    load: vi.fn(async () => player),
    saveAt: vi.fn(async (_user: string, revision: number) => history.get(revision) ?? null),
    ledgerAt: vi.fn(async () => null),
    consumeOverride: vi.fn(async () =>
      ++overrides > sync.plausibility.overrideMaxPerHour
        ? ('rate-limited' as const)
        : ('ok' as const),
    ),
    commit: vi.fn(async (args: CommitArgs) => {
      commits.push(args)
      const accepted: CommitOutcome = {
        ok: true,
        revision: args.expectedRevision + 1,
        acceptedAt: 'now',
      }
      return outcome ?? accepted
    }),
    quarantine: vi.fn(async (args: QuarantineArgs) => {
      quarantined.push(args)
      return 'ok' as const
    }),
  }
  return {
    backend,
    commits,
    quarantined,
    failCommit: (next: CommitOutcome) => (outcome = next),
    keep: (revision: number, save: HistorySave) => history.set(revision, save),
  }
}

const body = (save: unknown, patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    saveVersion: SAVE_VERSION,
    baseRevision: 0,
    deviceId: DEVICE,
    clientSavedAt: NOW,
    save,
    ...patch,
  })

const upload = (backend: SaveBackend, text: string, authorization: string | null = 'Bearer good') =>
  handleUpload({ authorization, bodyText: text }, backend, serverCeilings(), NOW, logger)

const stored = (save: SaveState, patch: Partial<StoredSave> = {}): StoredSave => ({
  revision: 3,
  saveVersion: SAVE_VERSION,
  data: save,
  acceptedAt: new Date(NOW - 60_000).toISOString(),
  deviceId: DEVICE,
  burstCreditMinutes: sync.plausibility.burstRealMinutes,
  paceCredit: serverCeilings().paceCreditCap,
  ...patch,
})

describe('POST /api/save', () => {
  const fresh = initialSave(config)

  it('needs a Bearer token for a real user', async () => {
    const { backend } = fakeBackend()
    expect((await upload(backend, body(fresh), null)).status).toBe(401)
    expect((await upload(backend, body(fresh), 'Bearer bad')).status).toBe(401)
    expect((await upload(backend, body(fresh), 'Basic good')).status).toBe(401)
  })

  it('refuses a malformed body and an oversized save', async () => {
    const { backend } = fakeBackend()
    expect((await upload(backend, '{')).body).toEqual({ ok: false, code: 'invalid' })
    expect((await upload(backend, body(fresh, { deviceId: 'phone' }))).status).toBe(400)
    expect((await upload(backend, body(fresh, { extra: 1 }))).status).toBe(400)
    const huge = { ...fresh, padding: 'x'.repeat(sync.maxSaveBytes) }
    expect((await upload(backend, body(huge))).status).toBe(413)
  })

  it('refuses an account without the 18+ attestation, or without a profile', async () => {
    expect((await upload(fakeBackend({ attested: false }).backend, body(fresh))).status).toBe(403)
    expect((await upload(fakeBackend(null).backend, body(fresh))).status).toBe(403)
  })

  it('refuses another save format', async () => {
    const { backend } = fakeBackend()
    const result = await upload(backend, body(fresh, { saveVersion: SAVE_VERSION + 1 }))
    expect(result).toEqual({
      status: 409,
      body: { ok: false, code: 'version', serverVersion: SAVE_VERSION },
    })
  })

  it('a first upload is stored at revision 1 with the public projection', async () => {
    const { backend, commits } = fakeBackend()
    const result = await upload(backend, body(fresh))
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, revision: 1, repairs: [], syncedGrantKeys: [] })
    expect(commits[0]).toMatchObject({
      userId: USER,
      expectedRevision: 0,
      saveVersion: SAVE_VERSION,
      deviceId: DEVICE,
      publicLevel: 'nobody',
      careerPath: null,
      sameRun: false,
      avatar: { cosmetics: [] },
      grants: [],
      burstCreditMinutes: sync.plausibility.burstRealMinutes,
    })
  })

  it('an upload based on an older revision conflicts and gets the cloud copy', async () => {
    const { backend, commits } = fakeBackend({ save: stored(fresh) })
    const result = await upload(backend, body(fresh, { baseRevision: 2 }))
    expect(result.status).toBe(409)
    expect(result.body).toEqual({
      ok: false,
      code: 'conflict',
      head: {
        revision: 3,
        saveVersion: SAVE_VERSION,
        acceptedAt: expect.any(String),
        deviceId: DEVICE,
      },
    })
    expect(commits).toEqual([])
  })

  it('a tampered save is kept aside, not stored (422)', async () => {
    const { backend, commits, quarantined } = fakeBackend({ save: stored(fresh) })
    const rich = { ...fresh, player: { ...fresh.player, cash: 1_000_000 } }
    const result = await upload(backend, body(rich, { baseRevision: 3 }))
    expect(result).toEqual({ status: 422, body: { ok: false, code: 'rejected' } })
    expect(commits).toEqual([])
    expect(quarantined[0]).toMatchObject({ baseRevision: 3 })
    expect(quarantined[0]?.findings).toContain('cash-flow')
  })

  it('a save that is not an object is quarantined wrapped', async () => {
    const { backend, quarantined } = fakeBackend({ save: stored(fresh) })
    const result = await upload(backend, body('nope', { baseRevision: 3 }))
    expect(result.status).toBe(422)
    expect(quarantined[0]?.data).toEqual({ upload: 'nope' })
  })

  it("commit_save's answers map to 409 and 429", async () => {
    const lost = fakeBackend()
    lost.failCommit({ ok: false, code: 'conflict' })
    expect((await upload(lost.backend, body(fresh))).body).toMatchObject({ code: 'conflict' })
    const busy = fakeBackend()
    busy.failCommit({ ok: false, code: 'rate-limited' })
    expect(await upload(busy.backend, body(fresh))).toEqual({
      status: 429,
      body: { ok: false, code: 'rate-limited', retryAfterMs: sync.minUploadIntervalMs },
    })
  })

  it('new grant records are inserted once and reported as synced', async () => {
    const base = initialSave(config)
    const reached = syncGoals(
      { ...base, player: playerWithClout(base.player, 150, config) },
      config,
    ).save
    const claimed = grant(
      reached,
      { kind: 'goal_reward', goalId: 'reach-local', reward: { cash: 50, clout: 15 } },
      NOW,
      config,
    )
    if (!claimed.ok) throw new Error(claimed.error.code)
    const save = { ...claimed.save, actions: 1 }
    const { backend, commits } = fakeBackend()
    const result = await upload(backend, body(save))
    expect(result.body).toMatchObject({ ok: true, syncedGrantKeys: ['goal:reach-local:r1'] })
    expect(commits[0]?.grants.map((row) => row.idempotency_key)).toEqual(['goal:reach-local:r1'])
    expect(commits[0]?.grants[0]?.user_id).toBe(USER)
  })

  it('refuses a device time no date can hold, and an envelope without a save (400)', async () => {
    const { backend, commits, quarantined } = fakeBackend()
    const farOff = await upload(backend, body(fresh, { clientSavedAt: Number.MAX_SAFE_INTEGER }))
    expect(farOff).toEqual({ status: 400, body: { ok: false, code: 'invalid' } })
    const noSave = await upload(
      backend,
      JSON.stringify({
        saveVersion: SAVE_VERSION,
        baseRevision: 0,
        deviceId: DEVICE,
        clientSavedAt: NOW,
      }),
    )
    expect(noSave).toEqual({ status: 400, body: { ok: false, code: 'invalid' } })
    expect(commits).toEqual([])
    expect(quarantined).toEqual([])
  })

  it('logs neither the user id, the token nor the save', async () => {
    const records: unknown[] = []
    const capture = createLogger({ sink: (record) => records.push(record), level: 'debug' })
    const { backend } = fakeBackend({ save: stored(fresh) })
    const rich = { ...fresh, player: { ...fresh.player, cash: 1_000_000 } }
    await handleUpload(
      { authorization: 'Bearer good', bodyText: body(rich, { baseRevision: 3 }) },
      backend,
      serverCeilings(),
      NOW,
      capture,
    )
    expect(records.length).toBeGreaterThan(0)
    const text = JSON.stringify(records)
    expect(text).not.toContain(USER)
    expect(text).not.toContain(DEVICE)
    expect(text).not.toContain('good')
    expect(text).not.toContain('1000000')
  })

  it('an upload a minute after the last accept carries the burst credit forward', async () => {
    const { backend, commits } = fakeBackend({ save: stored(fresh, { burstCreditMinutes: 2 }) })
    const next = { ...fresh, clock: { ...fresh.clock, minute: fresh.clock.minute + 1 } }
    const result = await upload(backend, body(next, { baseRevision: 3 }))
    expect(result.status).toBe(200)
    expect(commits[0]).toMatchObject({ expectedRevision: 3, sameRun: true })
    // One real minute since the accept plus the two carried, less the twentieth of a minute
    // the clock's one game minute needs at the fastest speed.
    expect(commits[0]?.burstCreditMinutes).toBeCloseTo(
      3 - 1 / serverCeilings().passiveGameMinutesPerRealMinute,
    )
  })
})

describe('keep this device (H2): checked against the save both devices shared', () => {
  /** The save both devices shared: Local reached, its reward not claimed yet. */
  const fresh = initialSave(config)
  const ancestor = syncGoals(
    { ...fresh, player: playerWithClout(fresh.player, 150, config) },
    config,
  ).save
  /** A device's later save: it claimed the reward (one tap). */
  function claimed(): SaveState {
    const result = grant(
      ancestor,
      { kind: 'goal_reward', goalId: 'reach-local', reward: { cash: 50, clout: 15 } },
      NOW,
      config,
    )
    if (!result.ok) throw new Error(result.error.code)
    return { ...result.save, actions: 1 }
  }
  /** Device Y's own play since the shared save: a few taps, a little cash. */
  const mine = (): SaveState => ({
    ...ancestor,
    actions: 2,
    clock: { ...ancestor.clock, minute: ancestor.clock.minute + 30 },
    player: { ...ancestor.player, cash: ancestor.player.cash + 20 },
  })
  const setup = (history: boolean) => {
    const theirs = claimed()
    const fake = fakeBackend({
      save: stored(theirs, { revision: 3 }),
      grantKeys: ['goal:reach-local:r1'],
    })
    if (history) {
      fake.keep(2, {
        saveVersion: SAVE_VERSION,
        data: ancestor,
        acceptedAt: new Date(NOW - 30 * 60_000).toISOString(),
        burstCreditMinutes: sync.plausibility.burstRealMinutes,
        paceCredit: serverCeilings().paceCreditCap,
      })
    }
    return fake
  }

  it('device X claims a goal, device Y keeps its own game: accepted on top of the head', async () => {
    const { backend, commits } = setup(true)
    const result = await upload(backend, body(mine(), { baseRevision: 3, overrideFromRevision: 2 }))
    expect(result.status).toBe(200)
    expect(commits[0]).toMatchObject({ expectedRevision: 3, grants: [] })
    expect(commits[0]?.data.player.cash).toBe(ancestor.player.cash + 20)
  })

  it('Y claimed the same reward on its branch: not a replay, and not inserted twice', async () => {
    const { backend, commits } = setup(true)
    const result = await upload(
      backend,
      body(claimed(), { baseRevision: 3, overrideFromRevision: 2 }),
    )
    expect(result.status).toBe(200)
    expect(commits[0]?.grants).toEqual([])
  })

  it('a forged kept game is still rejected', async () => {
    const { backend, commits, quarantined } = setup(true)
    const forged = { ...mine(), player: { ...mine().player, cash: 1_000_000 } }
    const result = await upload(backend, body(forged, { baseRevision: 3, overrideFromRevision: 2 }))
    expect(result.status).toBe(422)
    expect(commits).toEqual([])
    expect(quarantined).toHaveLength(1)
  })

  it('a shared save the history no longer keeps: a whole run against real time, never first-upload rules', async () => {
    const { backend } = setup(false)
    // As far along as the account's save (the same grant claimed): accepted.
    const kept = await upload(
      backend,
      body(claimed(), { baseRevision: 3, overrideFromRevision: 2 }),
    )
    expect(kept.status).toBe(200)
    const rich = { ...claimed(), player: { ...claimed().player, cash: 1_000_000 } }
    const refused = await upload(backend, body(rich, { baseRevision: 3, overrideFromRevision: 2 }))
    expect(refused.status).toBe(422)
  })

  it('without the shared save, a kept game behind the account in grants is accepted (N1)', async () => {
    const { backend, commits } = setup(false)
    const result = await upload(backend, body(mine(), { baseRevision: 3, overrideFromRevision: 2 }))
    expect(result.status).toBe(200)
    expect(commits[0]?.grants).toEqual([])
  })

  it('"keep this device" is rate limited per hour (429)', async () => {
    const { backend } = setup(true)
    const statuses: number[] = []
    for (let i = 0; i <= sync.plausibility.overrideMaxPerHour; i++) {
      statuses.push(
        (await upload(backend, body(mine(), { baseRevision: 3, overrideFromRevision: 2 }))).status,
      )
    }
    expect(statuses.at(-1)).toBe(429)
    expect(statuses.slice(0, -1).every((status) => status !== 429)).toBe(true)
  })

  it('an override at or past the head is not a branch: 400', async () => {
    const { backend } = setup(true)
    const result = await upload(backend, body(mine(), { baseRevision: 3, overrideFromRevision: 3 }))
    expect(result).toEqual({ status: 400, body: { ok: false, code: 'invalid' } })
  })
})
