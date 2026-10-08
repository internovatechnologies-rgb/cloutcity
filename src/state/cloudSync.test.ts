/**
 * Cloud save sync (S18c) on the device, against a fake Supabase client, fetch, clock and timers:
 * the restore decision table, debounced uploads, the offline queue, the server's replies, the
 * conflict choice and the volumes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import audioJson from '@data/config/audio.json'
import syncJson from '@data/config/sync.json'
import { engineConfig as config } from '@/engine/config'
import { syncGoals } from '@/engine/goals'
import { SAVE_VERSION, initialSave, type SaveState } from '@/engine/save'
import { playerWithClout } from '@/engine/test-support'
import type { Database } from '@/lib/supabase/database.types'
import { createLogger } from '@/lib/log'
import type { CloudCopy, UploadBody, UploadReply } from '@/lib/sync/protocol'
import { createAudioSettingsStore, type PersistedAudioSettings } from './audioSettings'
import { SYNC_META_KEY, cloudSignature, createCloudSync, type CloudSyncDeps } from './cloudSync'
import { createSafeJsonStorage } from './storage'
import { createGameStore, persistedOf, type PersistedState } from './store'
import { createSyncStatusStore } from './syncStatus'

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
}

const T0 = Date.parse('2026-10-07T12:00:00Z')
const USER = 'user-1'
const DEVICE = 'device-1'
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

interface CloudRow {
  revision: number
  save_version: number
  data: unknown
  accepted_at: string | null
  last_device_id: string | null
}

function setup(options: { cloud?: CloudRow | null; online?: boolean; local?: SaveState } = {}) {
  const logger = createLogger({ sink: () => {} })
  const local = new MemoryStorage()
  const game = createGameStore(
    createSafeJsonStorage<PersistedState>(() => local, logger),
    logger,
  )
  if (options.local !== undefined) game.setState(options.local)
  const audio = createAudioSettingsStore(
    createSafeJsonStorage<PersistedAudioSettings>(() => local, logger),
    audioJson,
    logger,
  )
  const status = createSyncStatusStore()
  let now = T0
  let online = options.online ?? true
  const timers: { at: number; run: () => void; id: number }[] = []
  let nextId = 1
  const onlineListeners: (() => void)[] = []
  const leaveListeners: (() => void)[] = []
  const uploads: { body: UploadBody; keepalive: boolean }[] = []
  const replies: ((body: UploadBody) => { status: number; reply: UploadReply })[] = []
  let cloud: CloudRow | null = options.cloud ?? null
  let serverAudio: { audio_settings: unknown; audio_settings_updated_at: string | null } = {
    audio_settings: null,
    audio_settings_updated_at: null,
  }
  const audioCalls: unknown[] = []

  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 'token', user: { id: USER } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => ({
      select: () => ({
        maybeSingle: async () =>
          table === 'saves' ? { data: cloud, error: null } : { data: serverAudio, error: null },
      }),
    }),
    rpc: async (_name: string, args: { p_volumes: unknown; p_updated_at: string }) => {
      audioCalls.push(args)
      serverAudio = {
        audio_settings: args.p_volumes,
        audio_settings_updated_at: args.p_updated_at,
      }
      return {
        data: [{ volumes: args.p_volumes, updated_at: args.p_updated_at }],
        error: null,
      }
    },
  } as unknown as SupabaseClient<Database>

  const accept = (body: UploadBody) => {
    const revision = body.baseRevision + 1
    cloud = {
      revision,
      save_version: body.saveVersion,
      data: body.save,
      accepted_at: new Date(now).toISOString(),
      last_device_id: body.deviceId,
    }
    return {
      status: 200,
      reply: {
        ok: true,
        revision,
        acceptedAt: new Date(now).toISOString(),
        repairs: [],
        syncedGrantKeys: (body.save as SaveState).grants.log.map((record) => record.key),
      } as UploadReply,
    }
  }

  const deps: CloudSyncDeps = {
    client,
    game,
    audio,
    status,
    storage: () => local,
    fetch: async (_url, init) => {
      if (!online) throw new TypeError('Failed to fetch')
      const body = JSON.parse(String(init?.body)) as UploadBody
      uploads.push({ body, keepalive: init?.keepalive === true })
      const { status: code, reply } = (replies.shift() ?? accept)(body)
      return new Response(JSON.stringify(reply), { status: code })
    },
    now: () => now,
    isOnline: () => online,
    timers: {
      set: (run, ms) => {
        const id = nextId++
        timers.push({ at: now + ms, run, id })
        return id
      },
      clear: (handle) => {
        const index = timers.findIndex((timer) => timer.id === handle)
        if (index >= 0) timers.splice(index, 1)
      },
    },
    onOnline: (listener) => {
      onlineListeners.push(listener)
      return () => {}
    },
    onLeave: (listener) => {
      leaveListeners.push(listener)
      return () => {}
    },
    randomId: () => DEVICE,
    logger,
  }

  /** Moves the clock on, running every timer that falls due. */
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (next === undefined || next.at > until) break
      timers.shift()
      now = next.at
      next.run()
      await settle()
    }
    now = until
    await settle()
  }

  return {
    deps,
    game,
    audio,
    status,
    local,
    uploads,
    replies,
    audioCalls,
    advance,
    accept,
    cloud: () => cloud,
    setCloud: (row: CloudRow | null) => (cloud = row),
    setServerAudio: (value: typeof serverAudio) => (serverAudio = value),
    goOnline: async () => {
      online = true
      for (const listener of onlineListeners) listener()
      await settle()
    },
    goOffline: () => (online = false),
    leave: async () => {
      for (const listener of leaveListeners) listener()
      await settle()
    },
    meta: () => JSON.parse(local.getItem(SYNC_META_KEY) ?? 'null') as Record<string, unknown>,
  }
}

/** A save someone has played: a few taps, a little cash. */
function played(base: SaveState = initialSave(config)): SaveState {
  return { ...base, actions: 3, player: { ...base.player, cash: base.player.cash + 5 } }
}

const row = (save: SaveState, revision: number, device: string): CloudRow => ({
  revision,
  save_version: SAVE_VERSION,
  data: save,
  accepted_at: new Date(T0 - 60_000).toISOString(),
  last_device_id: device,
})

describe('cloud save sync: restore', () => {
  it('with no cloud save, uploads this device and is then synced', async () => {
    const s = setup()
    const sync = createCloudSync(s.deps)
    await sync.ready
    expect(s.uploads).toHaveLength(1)
    expect(s.uploads[0]?.body).toMatchObject({
      saveVersion: SAVE_VERSION,
      baseRevision: 0,
      deviceId: DEVICE,
    })
    expect(s.status.getState().status).toBe('synced')
    expect(s.meta()).toMatchObject({ revision: 1, deviceId: DEVICE, userId: USER })
    sync.stop()
  })

  it('a fresh game on this device takes the account save', async () => {
    const theirs = played()
    const s = setup({ cloud: row(theirs, 4, 'other-device') })
    const sync = createCloudSync(s.deps)
    await sync.ready
    expect(s.uploads).toEqual([])
    expect(persistedOf(s.game.getState())).toEqual(theirs)
    expect(s.meta()).toMatchObject({ revision: 4, cloudSignature: cloudSignature(theirs) })
    expect(s.status.getState().status).toBe('synced')
    sync.stop()
  })

  it('different progress on both sides is a conflict the player settles', async () => {
    const mine = played()
    const theirs = { ...played(), actions: 9 }
    const s = setup({ cloud: row(theirs, 4, 'other-device'), local: mine })
    const sync = createCloudSync(s.deps)
    await sync.ready
    expect(s.status.getState().status).toBe('conflict')
    expect(s.uploads).toEqual([])
    s.status.getState().controls?.resolveConflict('keep-local')
    await settle()
    // Checked against the save both devices shared: here none was ever synced (revision 0).
    expect(s.uploads[0]?.body).toMatchObject({ baseRevision: 4, overrideFromRevision: 0 })
    expect((s.uploads[0]?.body.save as SaveState).actions).toBe(3)
    expect(s.status.getState().status).toBe('synced')
    sync.stop()
  })

  it('choosing the account save replaces this device', async () => {
    const theirs = { ...played(), actions: 9 }
    const s = setup({ cloud: row(theirs, 4, 'other-device'), local: played() })
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.status.getState().controls?.resolveConflict('use-cloud')
    await settle()
    expect(persistedOf(s.game.getState())).toEqual(theirs)
    expect(s.uploads).toEqual([])
    expect(s.status.getState().status).toBe('synced')
    sync.stop()
  })

  it("this device's own later save (a reply that never came) is built on, not fought", async () => {
    const s = setup({ cloud: row(played(), 5, DEVICE), local: played() })
    const sync = createCloudSync(s.deps)
    await sync.ready
    expect(s.status.getState().status).toBe('synced')
    expect(s.uploads[0]?.body.baseRevision).toBe(5)
    sync.stop()
  })

  it('a cloud save from a newer build stops sync with `update`', async () => {
    const s = setup({ cloud: { ...row(played(), 2, 'other'), save_version: SAVE_VERSION + 1 } })
    const sync = createCloudSync(s.deps)
    await sync.ready
    expect(s.status.getState().status).toBe('update')
    expect(s.uploads).toEqual([])
    sync.stop()
  })
})

describe('cloud save sync: uploads', () => {
  it('debounces changes, and uploads by maxWaitMs while play keeps changing the save', async () => {
    const s = setup()
    const sync = createCloudSync(s.deps)
    await sync.ready
    expect(s.uploads).toHaveLength(1)
    s.game.getState().performAction('nap')
    expect(s.status.getState().status).toBe('syncing')
    await s.advance(syncJson.debounceMs - 1)
    expect(s.uploads).toHaveLength(1)
    await s.advance(1)
    expect(s.uploads).toHaveLength(2)
    expect((s.uploads[1]?.body.save as SaveState).actions).toBe(1)

    // A change every few seconds never lets the debounce run out: maxWaitMs still uploads.
    for (let elapsed = 0; elapsed < syncJson.maxWaitMs; elapsed += syncJson.debounceMs / 2) {
      s.game.setState({ actions: s.game.getState().actions + 1 })
      await s.advance(syncJson.debounceMs / 2)
    }
    expect(s.uploads.length).toBeGreaterThanOrEqual(3)
    sync.stop()
  })

  it('passive time alone is no reason to upload', async () => {
    const s = setup()
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.game.setState({ clock: { minute: 900, remainderMs: 0 } })
    await s.advance(syncJson.maxWaitMs)
    expect(s.uploads).toHaveLength(1)
    sync.stop()
  })

  it('offline play queues and syncs when the network returns', async () => {
    const s = setup()
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.goOffline()
    s.game.getState().performAction('nap')
    expect(s.status.getState().status).toBe('offline')
    await s.advance(syncJson.maxWaitMs * 3)
    expect(s.uploads).toHaveLength(1)
    expect(s.status.getState().status).toBe('offline')
    await s.goOnline()
    expect(s.uploads).toHaveLength(2)
    expect(s.status.getState().status).toBe('synced')
    sync.stop()
  })

  it('a hidden tab flushes at once with a keepalive request', async () => {
    const s = setup()
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.game.getState().performAction('nap')
    await s.leave()
    expect(s.uploads.at(-1)?.keepalive).toBe(true)
    sync.stop()
  })

  it('a refused save pauses sync and tries again after rejectedRetryMs', async () => {
    const s = setup()
    s.replies.push(() => ({ status: 422, reply: { ok: false, code: 'rejected' } }))
    const sync = createCloudSync(s.deps)
    await sync.ready
    expect(s.status.getState().status).toBe('paused')
    await s.advance(syncJson.rejectedRetryMs - 1)
    expect(s.uploads).toHaveLength(1)
    await s.advance(1)
    expect(s.uploads).toHaveLength(2)
    expect(s.status.getState().status).toBe('synced')
    sync.stop()
  })

  it('"try again now" lifts the pause', async () => {
    const s = setup()
    s.replies.push(() => ({ status: 422, reply: { ok: false, code: 'rejected' } }))
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.status.getState().controls?.retryNow()
    await settle()
    expect(s.uploads).toHaveLength(2)
    expect(s.status.getState().status).toBe('synced')
    sync.stop()
  })

  it('applies the repairs the server made and marks the grants it holds', async () => {
    const base = initialSave(config)
    const reached = syncGoals(
      { ...base, player: playerWithClout(base.player, 150, config), actions: 1 },
      config,
    ).save
    const s = setup({ local: reached })
    s.game.getState().claimGoalReward('reach-local')
    const goal = Object.keys(s.game.getState().goals.achieved)[0] ?? ''
    s.replies.push((body) => {
      const accepted = s.accept(body)
      return {
        status: 200,
        reply: {
          ...(accepted.reply as Extract<UploadReply, { ok: true }>),
          repairs: [{ kind: 'drop-goal', goalId: goal, victory: false }],
        },
      }
    })
    const sync = createCloudSync(s.deps)
    await sync.ready
    const state = s.game.getState()
    expect(Object.keys(state.goals.achieved)).not.toContain(goal)
    expect(state.grants.log.map((record) => record.sync)).toEqual(['synced'])
    // What the device now holds is what the server stored: nothing left to upload.
    await s.advance(syncJson.maxWaitMs)
    expect(s.uploads).toHaveLength(1)
    sync.stop()
  })

  it('a conflict on upload from another device asks the player', async () => {
    const s = setup()
    const cloud: CloudCopy = {
      revision: 7,
      saveVersion: SAVE_VERSION,
      data: played(),
      acceptedAt: null,
      deviceId: 'other-device',
    }
    s.replies.push(() => {
      // Another device's save lands first: the reply names the head, the device reads it.
      s.setCloud({
        revision: cloud.revision,
        save_version: cloud.saveVersion,
        data: cloud.data,
        accepted_at: cloud.acceptedAt,
        last_device_id: cloud.deviceId,
      })
      const head = {
        revision: cloud.revision,
        saveVersion: cloud.saveVersion,
        acceptedAt: cloud.acceptedAt,
        deviceId: cloud.deviceId,
      }
      return { status: 409, reply: { ok: false, code: 'conflict', head } }
    })
    const sync = createCloudSync(s.deps)
    await sync.ready
    expect(s.status.getState().status).toBe('conflict')
    s.game.getState().performAction('nap')
    await s.advance(syncJson.maxWaitMs)
    expect(s.uploads).toHaveLength(1)
    sync.stop()
  })

  it("waits out the server's upload interval instead of provoking a 429", async () => {
    const s = setup()
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.game.getState().performAction('nap')
    await s.leave()
    // A keepalive flush is the page going away: it never waits.
    expect(s.uploads).toHaveLength(2)
    s.game.getState().performAction('nap')
    await s.goOnline()
    expect(s.uploads).toHaveLength(2)
    await s.advance(syncJson.minUploadIntervalMs)
    expect(s.uploads).toHaveLength(3)
    sync.stop()
  })

  it('a rate limit waits and tries again', async () => {
    const s = setup()
    s.replies.push(() => ({
      status: 429,
      reply: { ok: false, code: 'rate-limited', retryAfterMs: 5000 },
    }))
    const sync = createCloudSync(s.deps)
    await sync.ready
    await s.advance(5000)
    expect(s.uploads).toHaveLength(2)
    expect(s.status.getState().status).toBe('synced')
    sync.stop()
  })
})

describe('cloud save sync: volumes', () => {
  it("takes the account's newer volumes", async () => {
    const s = setup()
    const at = new Date(T0 - 1000).toISOString()
    s.setServerAudio({
      audio_settings: { master: 10, music: 20, sfx: 30, ambience: 40, voice: 50 },
      audio_settings_updated_at: at,
    })
    const sync = createCloudSync(s.deps)
    await sync.ready
    await settle()
    expect(s.audio.getState()).toMatchObject({
      volumes: { master: 10, music: 20, sfx: 30, ambience: 40, voice: 50 },
      updatedAt: Date.parse(at),
    })
    await s.advance(5000)
    expect(s.audioCalls).toEqual([])
    sync.stop()
  })

  it('sends a change made on this device, after a short quiet time', async () => {
    const s = setup()
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.audio.getState().setVolume('music', 30, T0)
    await s.advance(5000)
    expect(s.audioCalls).toHaveLength(1)
    expect(s.audioCalls[0]).toMatchObject({ p_updated_at: new Date(T0).toISOString() })
    sync.stop()
  })
})

describe('cloud save sync: review probes (S18c bug-hunter)', () => {
  /** A server that checks the revision like commit_save: a stale base gets the cloud copy. */
  const cas =
    (s: ReturnType<typeof setup>) =>
    (body: UploadBody): { status: number; reply: UploadReply } => {
      const current = s.cloud()
      if ((current?.revision ?? 0) !== body.baseRevision) {
        return {
          status: 409,
          reply: {
            ok: false,
            code: 'conflict',
            head:
              current === null
                ? null
                : {
                    revision: current.revision,
                    saveVersion: current.save_version,
                    acceptedAt: current.accepted_at,
                    deviceId: current.last_device_id,
                  },
          },
        }
      }
      return s.accept(body)
    }
  const serve = (s: ReturnType<typeof setup>, times = 10) => {
    for (let i = 0; i < times; i++) s.replies.push(cas(s))
  }

  /** A second tab of the same game: the same storage (and device id), its own page state. */
  const secondTab = (s: ReturnType<typeof setup>) => {
    const logger = createLogger({ sink: () => {} })
    const game = createGameStore(
      createSafeJsonStorage<PersistedState>(() => s.local, logger),
      logger,
    )
    const status = createSyncStatusStore()
    return { game, status, deps: { ...s.deps, game, status } }
  }

  it("a second tab's stale save is not uploaded over the first tab's (same device id)", async () => {
    const s = setup()
    serve(s)
    const tabA = createCloudSync(s.deps)
    await tabA.ready
    const b = secondTab(s)
    const tabB = createCloudSync(b.deps)
    await tabB.ready
    // Tab A plays on and syncs; tab B, still on the first revision, plays something else.
    s.game.getState().performAction('sleep')
    await s.advance(syncJson.debounceMs)
    const afterA = s.cloud()
    expect(afterA?.revision).toBe(2)
    b.game.getState().performAction('nap')
    await s.advance(syncJson.debounceMs + syncJson.minUploadIntervalMs)
    // Tab B never sent revision 2: it is another copy of the game, not B's lost reply.
    expect(b.status.getState().status).toBe('conflict')
    expect(s.cloud()).toEqual(afterA)
    tabA.stop()
    tabB.stop()
  })

  it('a reply lost in flight is still built on (this page sent that save)', async () => {
    const s = setup()
    serve(s, 1)
    s.replies.push((body) => {
      s.accept(body)
      throw new TypeError('Failed to fetch')
    })
    serve(s)
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.game.getState().performAction('nap')
    await s.advance(syncJson.debounceMs)
    expect(s.cloud()?.revision).toBe(2)
    s.game.getState().performAction('nap')
    await s.advance(syncJson.retry.maxMs)
    expect(s.status.getState().status).toBe('synced')
    expect(s.cloud()?.revision).toBe(3)
    expect((s.cloud()?.data as SaveState).actions).toBe(2)
    sync.stop()
  })

  it('a keepalive flush whose reply never came is built on after a reload', async () => {
    const s = setup()
    serve(s, 1)
    const first = createCloudSync(s.deps)
    await first.ready
    s.game.getState().performAction('nap')
    // The page goes away: the keepalive request lands, its reply is never read.
    s.replies.push((body) => {
      s.accept(body)
      throw new TypeError('Failed to fetch')
    })
    await s.leave()
    first.stop()
    expect(s.cloud()?.revision).toBe(2)
    serve(s)
    const reloaded = secondTab(s)
    const second = createCloudSync(reloaded.deps)
    await second.ready
    expect(reloaded.status.getState().status).toBe('synced')
    second.stop()
  })

  it('a migrated save with progress but no counted taps is not overwritten by the account', async () => {
    // A v8 save upgrades with actions 0: real progress the tap counter never saw.
    const base = initialSave(config)
    const mine: SaveState = {
      ...base,
      actions: 0,
      player: playerWithClout({ ...base.player, cash: base.player.cash + 400 }, 150, config),
    }
    const theirs = { ...played(), actions: 9 }
    const s = setup({ cloud: row(theirs, 4, 'other-device'), local: mine })
    const sync = createCloudSync(s.deps)
    await sync.ready
    expect(s.status.getState().status).toBe('conflict')
    expect(persistedOf(s.game.getState()).player.cash).toBe(mine.player.cash)
    sync.stop()
  })

  it('another account on this device does not count as this device for the new account', async () => {
    // This device once uploaded for account B, then played as account A; now B signs in again.
    const s = setup({ cloud: row({ ...played(), actions: 9 }, 6, DEVICE), local: played() })
    s.local.setItem(
      SYNC_META_KEY,
      JSON.stringify({
        version: 1,
        deviceId: DEVICE,
        userId: 'user-a',
        revision: 2,
        cloudSignature: null,
      }),
    )
    const sync = createCloudSync(s.deps)
    await sync.ready
    expect(s.status.getState().status).toBe('conflict')
    expect(s.uploads).toEqual([])
    sync.stop()
  })
})

describe('cloud save sync: after a refused save (H2)', () => {
  it('"Use the cloud game" takes the account save, only when tapped', async () => {
    const theirs = { ...played(), actions: 9 }
    const s = setup({ cloud: row(theirs, 4, 'other-device'), local: played() })
    s.replies.push(() => ({ status: 422, reply: { ok: false, code: 'rejected' } }))
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.status.getState().controls?.resolveConflict('keep-local')
    await settle()
    expect(s.status.getState()).toMatchObject({ status: 'paused', rejected: true })
    // Nothing is taken on its own, however long it waits.
    expect(s.game.getState().actions).toBe(3)
    s.status.getState().controls?.useCloud()
    await settle()
    expect(persistedOf(s.game.getState())).toEqual(theirs)
    expect(s.status.getState()).toMatchObject({ status: 'synced', rejected: false })
    expect(s.meta()).toMatchObject({ revision: 4, overrideFrom: null })
    sync.stop()
  })

  it('the keep-local override is sent until an upload is accepted, then dropped', async () => {
    const theirs = { ...played(), actions: 9 }
    const s = setup({ cloud: row(theirs, 4, 'other-device'), local: played() })
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.status.getState().controls?.resolveConflict('keep-local')
    await settle()
    expect(s.uploads.at(-1)?.body.overrideFromRevision).toBe(0)
    s.game.getState().performAction('nap')
    await s.advance(syncJson.maxWaitMs)
    expect(s.uploads.at(-1)?.body.overrideFromRevision).toBeUndefined()
    sync.stop()
  })
})

describe('cloud save sync: a kept game behind the account (N2)', () => {
  it('stops with "behind", never retries, and offers the account game', async () => {
    const theirs = { ...played(), actions: 9 }
    const s = setup({ cloud: row(theirs, 4, 'other-device'), local: played() })
    s.replies.push(() => ({ status: 409, reply: { ok: false, code: 'branch-behind' } }))
    const sync = createCloudSync(s.deps)
    await sync.ready
    s.status.getState().controls?.resolveConflict('keep-local')
    await settle()
    expect(s.status.getState().status).toBe('behind')
    const sent = s.uploads.length
    s.game.getState().performAction('nap')
    await s.advance(syncJson.rejectedRetryMs * 2)
    expect(s.uploads).toHaveLength(sent)
    s.status.getState().controls?.useCloud()
    await settle()
    expect(persistedOf(s.game.getState())).toEqual(theirs)
    expect(s.status.getState().status).toBe('synced')
    sync.stop()
  })
})
