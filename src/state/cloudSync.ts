/**
 * Cloud save sync (S18c). Loaded lazily, with the Supabase chunk, once the guest session has
 * connected (src/state/session.ts): play never waits on it, and without a session the save
 * stays on this device ("Saved on this device").
 *
 * - Restore: on start the account's save is read (RLS: the player's own row) and compared with
 *   this device's sync record (`cloutcity:sync`: device id, the cloud revision the local save is
 *   based on, and the signature of what was last synced):
 *     | account                          | this device                       | then                     |
 *     | no save                          | anything                          | upload                   |
 *     | newer save format                | anything                          | `update`, no upload      |
 *     | same revision                    | anything                          | upload if changed        |
 *     | other revision, an upload this   | anything                          | rebase on it, upload     |
 *     | device sent (its reply was lost) |                                   |                          |
 *     | other revision                   | unchanged since the last sync, or | adopt the account's save |
 *     |                                  | never played (a fresh game)       |                          |
 *     | other revision                   | changed                           | `conflict`: player picks |
 *   An upload "this device sent" is one whose mark (`uploadMark`) the sync record kept when it was
 *   sent: the device id alone also matches another tab of the game, or this device's upload for
 *   another account.
 * - Upload: a meaningful change (anything but the clock's minute) is uploaded after
 *   `sync.debounceMs` of quiet, and at most `sync.maxWaitMs` after the first change. A hidden tab
 *   or a page being left flushes at once with a keepalive request (if it fits
 *   `sync.keepaliveMaxBytes`). Offline, changes wait for the network (`offline`). Failures back
 *   off exponentially (`sync.retry`); a save the server refuses pauses sync (`paused`) for
 *   `sync.rejectedRetryMs`; a conflict (409, naming the head only: the save is read with this
 *   session) waits for the player's choice in the sheet. "Keep this device" uploads on top of the
 *   account's save with `overrideFromRevision`, the revision this device last synced, so the
 *   server checks it against the save both devices shared. After a refused save the sheet also
 *   offers the account's game (`useCloud`), taken only on a tap.
 * - The server's repairs are applied to the game (`applyRepairs`) and the grants it holds are
 *   marked synced, so the next upload starts from what the server stored.
 * - Volumes (src/state/audioSettings.ts) sync too: the newer change wins.
 *
 * Nothing here logs the save, the user id or a token.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import * as z from 'zod/mini'
import syncJson from '@data/config/sync.json'
import { engineConfig } from '@/engine/config'
import { applyRepairs } from '@/engine/repairs'
import { SAVE_VERSION, type SaveState } from '@/engine/save'
import type { Database } from '@/lib/supabase/database.types'
import type { SyncConfig } from '@/lib/data/schemas/config'
import { log, type Logger } from '@/lib/log'
import { SAVE_ROUTE, type CloudCopy, type UploadBody } from '@/lib/sync/protocol'
import { audioSettingsStore, type AudioSettingsStore } from './audioSettings'
import { browserLocalStorage } from './storage'
import { gameStore, persistedOf, type GameStore } from './store'
import { syncStatusStore, type SyncStatus, type SyncStatusStore } from './syncStatus'

// Validated with the other config files (src/lib/data/data.test.ts); read directly to keep
// classic zod out of the client.
const SYNC = syncJson as SyncConfig

export const SYNC_META_KEY = 'cloutcity:sync'
const META_VERSION = 1
/** Quiet time after a volume change before it goes to the account. */
const AUDIO_DEBOUNCE_MS = 2000

const MetaSchema = z.strictObject({
  version: z.literal(META_VERSION),
  deviceId: z.string().check(z.minLength(1)),
  /** The account the record belongs to; another account starts the record over. */
  userId: z.string(),
  revision: z.int().check(z.gte(0)),
  cloudSignature: z.nullable(z.string()),
  /** Marks (`uploadMark`) of uploads sent whose reply has not arrived, newest last. */
  sent: z.optional(z.array(z.string())),
  /**
   * "Keep this device" under way: the revision this device last synced before the conflict, the
   * save both devices shared. Sent as `overrideFromRevision` until the server accepts the upload.
   */
  overrideFrom: z.optional(z.nullable(z.int().check(z.gte(0)))),
})
type Meta = z.infer<typeof MetaSchema>

const RepairSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('drop-goal'), goalId: z.string(), victory: z.boolean() }),
  z.object({ kind: z.literal('drop-badge'), badge: z.string() }),
  z.object({ kind: z.literal('mark-kept'), itemId: z.string() }),
  z.object({ kind: z.literal('set-peak'), peakLevel: z.int() }),
  z.object({ kind: z.literal('drop-premium'), itemId: z.nullable(z.string()) }),
])

const CloudHeadSchema = z.object({
  revision: z.int(),
  saveVersion: z.int(),
  acceptedAt: z.nullable(z.string()),
  deviceId: z.nullable(z.string()),
})

const ReplySchema = z.union([
  z.object({
    ok: z.literal(true),
    revision: z.int(),
    acceptedAt: z.string(),
    repairs: z.array(RepairSchema),
    syncedGrantKeys: z.array(z.string()),
  }),
  z.object({
    ok: z.literal(false),
    code: z.literal('conflict'),
    head: z.nullable(CloudHeadSchema),
  }),
  z.object({ ok: z.literal(false), code: z.literal('rate-limited'), retryAfterMs: z.number() }),
  z.object({ ok: z.literal(false), code: z.literal('version'), serverVersion: z.int() }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'rejected',
      'unauthenticated',
      'attestation-required',
      'invalid',
      'too-large',
      'branch-behind',
      'unavailable',
    ]),
  }),
])

const VolumesSchema = z.strictObject({
  master: z.int(),
  music: z.int(),
  sfx: z.int(),
  ambience: z.int(),
  voice: z.int(),
})

/**
 * What decides whether the save needs uploading: everything a save holds except the clock's
 * minute (passive time alone is not worth an upload; the next change carries it) and grant
 * records' sync marks (bookkeeping the server ignores).
 */
export function cloudSignature(save: SaveState): string {
  const grants = {
    ...save.grants,
    log: save.grants.log.map((record) => ({ ...record, sync: null })),
  }
  return JSON.stringify({ ...save, clock: null, grants })
}

/** Unanswered uploads the sync record remembers. */
const SENT_KEEP = 8

/**
 * What tells one uploaded save from another, whatever the server's repairs (which never touch
 * these fields) or a jsonb round trip did to it; null for something that is not a save.
 */
export function uploadMark(save: unknown): string | null {
  if (typeof save !== 'object' || save === null) return null
  const s = save as {
    clock?: { minute?: unknown }
    actions?: unknown
    player?: { cash?: unknown; clout?: { nextSeq?: unknown } }
    grants?: { nextSeq?: unknown }
    prestige?: { count?: unknown }
  }
  return JSON.stringify([
    s.clock?.minute ?? null,
    s.actions ?? null,
    s.player?.cash ?? null,
    s.player?.clout?.nextSeq ?? null,
    s.grants?.nextSeq ?? null,
    s.prestige?.count ?? null,
  ])
}

/**
 * A game nobody has played yet: nothing in it is worth keeping over the account's save. The tap
 * count alone is not enough: a save from before it existed (v8) upgrades with 0 taps.
 */
function untouched(save: SaveState): boolean {
  const { player } = save
  return (
    save.actions === 0 &&
    save.prestige.history.length === 0 &&
    save.grants.log.length === 0 &&
    Object.keys(save.goals.achieved).length === 0 &&
    player.clout.nextSeq === 1 &&
    player.cash <= engineConfig.startCash &&
    player.home === engineConfig.startHome &&
    player.inventory.wearables.length === 0 &&
    player.inventory.gifts.length === 0 &&
    Object.keys(player.visited).length === 0 &&
    Object.keys(player.clubNights).length === 0
  )
}

export interface Timers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** What sync needs from the browser and the network; injectable for tests. */
export interface CloudSyncDeps {
  readonly client: SupabaseClient<Database>
  readonly game: GameStore
  readonly audio: AudioSettingsStore
  readonly status: SyncStatusStore
  readonly storage: () => Storage | undefined
  readonly fetch: typeof fetch
  readonly now: () => number
  readonly isOnline: () => boolean
  readonly timers: Timers
  /** Calls `listener` whenever the browser comes back online; returns a way to stop. */
  readonly onOnline: (listener: () => void) => () => void
  /** Calls `listener` when the page is hidden or being left; returns a way to stop. */
  readonly onLeave: (listener: () => void) => () => void
  readonly randomId: () => string
  readonly logger: Logger
}

export function browserSyncDeps(client: SupabaseClient<Database>): CloudSyncDeps {
  return {
    client,
    game: gameStore,
    audio: audioSettingsStore,
    status: syncStatusStore,
    storage: browserLocalStorage,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    isOnline: () => navigator.onLine,
    timers: {
      set: (callback, ms) => window.setTimeout(callback, ms),
      clear: (handle) => window.clearTimeout(handle as number),
    },
    onOnline: (listener) => {
      window.addEventListener('online', listener)
      return () => window.removeEventListener('online', listener)
    },
    onLeave: (listener) => {
      const hidden = () => {
        if (document.visibilityState === 'hidden') listener()
      }
      document.addEventListener('visibilitychange', hidden)
      window.addEventListener('pagehide', listener)
      return () => {
        document.removeEventListener('visibilitychange', hidden)
        window.removeEventListener('pagehide', listener)
      }
    },
    randomId: () => crypto.randomUUID(),
    logger: log,
  }
}

export interface CloudSync {
  /** Stops every timer and listener (tests; a page keeps it running). */
  stop(): void
  /** Settles when the restore decision and the first upload (if any) are done (tests). */
  readonly ready: Promise<void>
}

let running: CloudSync | undefined

/**
 * Starts sync once per page, on the client the guest session just connected with
 * (src/lib/supabase/supabaseAuth.ts `supabaseClient`, passed in so this module never
 * imports supabase-js itself).
 */
export function startCloudSync(
  client: SupabaseClient<Database> | undefined,
): CloudSync | undefined {
  if (running !== undefined) return running
  if (client === undefined) return undefined
  running = createCloudSync(browserSyncDeps(client))
  return running
}

export function createCloudSync(deps: CloudSyncDeps): CloudSync {
  const { game, status, timers, logger } = deps
  let meta: Meta | null = null
  let token: string | null = null
  let stopped = false
  let inflight: Promise<void> | null = null
  let pendingTimer: unknown = null
  let retryTimer: unknown = null
  let firstChangeAt: number | null = null
  let failures = 0
  let pausedUntil = 0
  /** When the server last accepted an upload from this page (its rate limit counts from it). */
  let acceptedAt = Number.NEGATIVE_INFINITY
  let blocked: 'conflict' | 'update' | 'behind' | null = null
  let conflict: CloudCopy | null = null
  const cleanups: (() => void)[] = []

  const setStatus = (next: SyncStatus) => {
    if (status.getState().status !== next) status.setState({ status: next })
  }
  const current = (): SaveState => persistedOf(game.getState())

  const readMeta = (userId: string): Meta => {
    let stored: Meta | null = null
    try {
      const raw = deps.storage()?.getItem(SYNC_META_KEY)
      const parsed = raw == null ? null : MetaSchema.safeParse(JSON.parse(raw))
      stored = parsed?.success === true ? parsed.data : null
    } catch {
      stored = null
    }
    const deviceId = stored?.deviceId ?? deps.randomId()
    if (stored !== null && stored.userId === userId) return stored
    return { version: META_VERSION, deviceId, userId, revision: 0, cloudSignature: null }
  }
  const writeMeta = (patch: Partial<Meta>) => {
    if (meta === null) return
    meta = { ...meta, ...patch }
    try {
      deps.storage()?.setItem(SYNC_META_KEY, JSON.stringify(meta))
    } catch {
      // Storage refused (private mode, quota): the record lasts for this page only.
    }
  }

  const changed = () => meta !== null && cloudSignature(current()) !== meta.cloudSignature

  /** True when `cloud` is an upload this device sent for this account (see the table above). */
  const sentHere = (cloud: CloudCopy, local: SaveState | null): boolean => {
    if (meta === null || cloud.deviceId !== meta.deviceId) return false
    const mark = uploadMark(cloud.data)
    return (
      mark !== null &&
      ((meta.sent ?? []).includes(mark) || (local !== null && mark === uploadMark(local)))
    )
  }

  const clearPending = () => {
    if (pendingTimer !== null) timers.clear(pendingTimer)
    pendingTimer = null
  }
  const retryIn = (ms: number) => {
    if (retryTimer !== null) timers.clear(retryTimer)
    retryTimer = timers.set(() => {
      retryTimer = null
      void flush()
    }, ms)
  }
  const backoff = () => {
    failures += 1
    return Math.min(SYNC.retry.maxMs, SYNC.retry.baseMs * 2 ** (failures - 1))
  }

  /** A change happened: upload after the debounce, or at the latest `maxWaitMs` after the first. */
  const schedule = () => {
    if (stopped || meta === null || blocked !== null || inflight !== null) return
    if (!changed()) {
      firstChangeAt = null
      clearPending()
      // Nothing waits to upload: the account holds this device's save.
      const now = status.getState().status
      if (now === 'local' || now === 'syncing' || now === 'offline') setStatus('synced')
      return
    }
    const now = deps.now()
    firstChangeAt ??= now
    const wait = Math.max(0, Math.min(SYNC.debounceMs, firstChangeAt + SYNC.maxWaitMs - now))
    clearPending()
    pendingTimer = timers.set(() => {
      pendingTimer = null
      void flush()
    }, wait)
    if (!deps.isOnline()) setStatus('offline')
    else if (now >= pausedUntil) setStatus('syncing')
  }

  const flush = async (keepalive = false): Promise<void> => {
    if (stopped || meta === null || blocked !== null) return
    if (inflight !== null) return inflight
    clearPending()
    if (!changed()) return schedule()
    if (!deps.isOnline()) {
      setStatus('offline')
      return
    }
    const now = deps.now()
    if (now < pausedUntil && !keepalive) {
      retryIn(pausedUntil - now)
      return
    }
    // The server refuses a second upload within minUploadIntervalMs (429): wait it out instead.
    const allowedAt = acceptedAt + SYNC.minUploadIntervalMs
    if (now < allowedAt && !keepalive) {
      retryIn(allowedAt - now)
      return
    }
    inflight = upload(keepalive).finally(() => {
      inflight = null
      schedule()
    })
    return inflight
  }

  const upload = async (keepalive: boolean): Promise<void> => {
    if (meta === null) return
    if (game.getState().newerSavePresent) return
    const save = current()
    const body: UploadBody = {
      saveVersion: SAVE_VERSION,
      baseRevision: meta.revision,
      deviceId: meta.deviceId,
      clientSavedAt: deps.now(),
      save,
      ...(meta.overrideFrom == null ? {} : { overrideFromRevision: meta.overrideFrom }),
    }
    const text = JSON.stringify(body)
    if (keepalive && text.length > SYNC.keepaliveMaxBytes) return
    if (!keepalive) {
      const session = await deps.client.auth.getSession()
      token = session.data.session?.access_token ?? null
    }
    if (token === null) {
      pausedUntil = deps.now() + backoff()
      setStatus('paused')
      retryIn(pausedUntil - deps.now())
      return
    }
    firstChangeAt = null
    const mark = uploadMark(save)
    if (mark !== null) writeMeta({ sent: [...(meta.sent ?? []), mark].slice(-SENT_KEEP) })
    let response: Response
    try {
      response = await deps.fetch(SAVE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: text,
        cache: 'no-store',
        keepalive,
      })
    } catch (error) {
      // No network, or the request was cut off: expected, retried.
      logger.info('A cloud save upload did not reach the server; retrying', {
        error: error instanceof Error ? error.name : typeof error,
      })
      if (!deps.isOnline()) setStatus('offline')
      else retryIn(backoff())
      return
    }
    let reply: z.infer<typeof ReplySchema>
    try {
      const parsed = ReplySchema.safeParse(await response.json())
      if (!parsed.success) throw new Error('unexpected reply')
      reply = parsed.data
    } catch {
      logger.warn('The cloud save server sent an unexpected reply', { status: response.status })
      pausedUntil = deps.now() + backoff()
      setStatus('paused')
      retryIn(pausedUntil - deps.now())
      return
    }
    await handleReply(reply, save)
  }

  const handleReply = async (reply: z.infer<typeof ReplySchema>, sent: SaveState) => {
    if (reply.ok) {
      failures = 0
      pausedUntil = 0
      acceptedAt = deps.now()
      writeMeta({
        revision: reply.revision,
        cloudSignature: cloudSignature(applyRepairs(sent, reply.repairs)),
        sent: [],
        overrideFrom: null,
      })
      status.setState({ rejected: false })
      game.getState().applyRepairs(reply.repairs)
      game.getState().markGrantsSynced(reply.syncedGrantKeys)
      if (reply.repairs.length > 0) {
        logger.info('The server repaired the cloud save', { repairs: reply.repairs.length })
      }
      setStatus('synced')
      return
    }
    switch (reply.code) {
      case 'conflict': {
        if (reply.head === null) {
          // The account has no save (it was removed): start its history over.
          writeMeta({ revision: 0, cloudSignature: null, overrideFrom: null })
          retryIn(0)
          return
        }
        // The reply names the head only: read the save itself with this session.
        const read = await readCloud()
        if (!read.ok) {
          pause(backoff())
          return
        }
        const cloud = read.cloud
        if (cloud === null) {
          writeMeta({ revision: 0, cloudSignature: null, overrideFrom: null })
          retryIn(0)
        } else if (sentHere(cloud, null)) {
          // This device's own upload landed, but its reply never arrived.
          writeMeta({ revision: cloud.revision })
          retryIn(0)
        } else {
          enterConflict(cloud)
        }
        return
      }
      case 'version':
        if (reply.serverVersion > SAVE_VERSION) {
          blocked = 'update'
          setStatus('update')
        } else {
          pause(SYNC.rejectedRetryMs)
        }
        return
      case 'rate-limited':
        retryIn(Math.max(reply.retryAfterMs, SYNC.retry.baseMs))
        return
      case 'rejected':
      case 'invalid':
      case 'too-large':
        logger.info('The server did not accept the cloud save; sync is paused', {
          code: reply.code,
        })
        // The panel then offers the account's game as a way out (never taken on its own).
        status.setState({ rejected: true })
        pause(SYNC.rejectedRetryMs)
        return
      case 'branch-behind':
        // This device's game is from before the account's last prestige: it cannot replace the
        // account's. No retry: the panel explains and offers the account's game (useCloud).
        logger.info("Kept this device's game, but it is behind the account in prestige")
        blocked = 'behind'
        writeMeta({ overrideFrom: null })
        setStatus('behind')
        return
      case 'unauthenticated':
      case 'attestation-required':
      case 'unavailable':
        pause(backoff())
        return
    }
  }

  const pause = (ms: number) => {
    pausedUntil = deps.now() + ms
    setStatus('paused')
    retryIn(ms)
  }

  const enterConflict = (cloud: CloudCopy) => {
    if (cloud.saveVersion > SAVE_VERSION) {
      blocked = 'update'
      setStatus('update')
      return
    }
    blocked = 'conflict'
    conflict = cloud
    clearPending()
    setStatus('conflict')
  }

  const adopt = (cloud: CloudCopy): boolean => {
    if (!game.getState().adoptCloudSave(cloud.data, cloud.saveVersion)) return false
    writeMeta({
      revision: cloud.revision,
      cloudSignature: cloudSignature(current()),
      overrideFrom: null,
    })
    pausedUntil = 0
    failures = 0
    status.setState({ rejected: false })
    setStatus('synced')
    return true
  }

  /** The account's save, read with this session (RLS: the player's own row). */
  const readCloud = async (): Promise<
    { readonly ok: true; readonly cloud: CloudCopy | null } | { readonly ok: false }
  > => {
    const { data, error } = await deps.client
      .from('saves')
      .select('revision, save_version, data, accepted_at, last_device_id')
      .maybeSingle()
    if (error !== null) {
      logger.info('Could not read the cloud save; trying again later', { code: error.code })
      return { ok: false }
    }
    return {
      ok: true,
      cloud:
        data === null
          ? null
          : {
              revision: data.revision,
              saveVersion: data.save_version,
              data: data.data,
              acceptedAt: data.accepted_at,
              deviceId: data.last_device_id,
            },
    }
  }

  const restore = async (): Promise<void> => {
    if (meta === null) return
    const read = await readCloud()
    if (!read.ok) {
      pause(backoff())
      return
    }
    const cloud = read.cloud
    if (cloud === null) {
      if (meta.revision !== 0) writeMeta({ revision: 0, cloudSignature: null, overrideFrom: null })
      return
    }
    if (cloud.saveVersion > SAVE_VERSION) {
      blocked = 'update'
      setStatus('update')
      return
    }
    if (cloud.revision === meta.revision) return
    const local = current()
    if (
      cloudSignature(local) === meta.cloudSignature ||
      (meta.revision === 0 && untouched(local))
    ) {
      if (adopt(cloud)) {
        logger.info('Restored the cloud save', { revision: cloud.revision })
        return
      }
      enterConflict(cloud)
      return
    }
    if (sentHere(cloud, local)) {
      writeMeta({ revision: cloud.revision })
      return
    }
    enterConflict(cloud)
  }

  status.setState({
    controls: {
      retryNow: () => {
        pausedUntil = 0
        failures = 0
        void flush()
      },
      resolveConflict: (choice) => {
        if (blocked !== 'conflict' || conflict === null) return
        const cloud = conflict
        blocked = null
        conflict = null
        if (choice === 'use-cloud' && adopt(cloud)) return
        // Keep this device's progress: upload it on top of the account's save, checked against
        // the save both devices last shared (the revision this device last synced).
        writeMeta({
          overrideFrom: meta?.overrideFrom ?? meta?.revision ?? 0,
          revision: cloud.revision,
        })
        void flush()
      },
      useCloud: () => {
        void (async () => {
          const read = await readCloud()
          if (read.ok && read.cloud !== null && read.cloud.saveVersion <= SAVE_VERSION) {
            blocked = null
            conflict = null
            if (adopt(read.cloud)) return
          }
          logger.info('Could not take the account save; sync stays paused')
        })()
      },
    },
  })

  const startAudioSync = () => {
    let audioTimer: unknown = null
    // The change time last taken from the account: adopting it is not a change to send back.
    let adoptedAt = -1
    const push = async () => {
      const { volumes, updatedAt } = deps.audio.getState()
      if (updatedAt === 0 || updatedAt === adoptedAt) return
      const { data, error } = await deps.client.rpc('set_audio_settings', {
        p_volumes: volumes,
        p_updated_at: new Date(updatedAt).toISOString(),
      })
      if (error !== null) {
        logger.info('Could not save the volumes to the account', { code: error.code })
        return
      }
      adoptAudio(data?.[0]?.volumes, data?.[0]?.updated_at ?? null)
    }
    const adoptAudio = (volumes: unknown, at: string | null) => {
      const parsed = VolumesSchema.safeParse(volumes)
      const atMs = at === null ? Number.NaN : Date.parse(at)
      if (!parsed.success || !Number.isFinite(atMs)) return
      if (atMs > deps.audio.getState().updatedAt) {
        adoptedAt = atMs
        deps.audio.setState({ volumes: parsed.data, updatedAt: atMs })
      }
    }
    void (async () => {
      const { data, error } = await deps.client
        .from('profiles')
        .select('audio_settings, audio_settings_updated_at')
        .maybeSingle()
      if (error !== null) return
      const serverAt =
        data?.audio_settings_updated_at == null ? 0 : Date.parse(data.audio_settings_updated_at)
      if (serverAt > deps.audio.getState().updatedAt) {
        adoptAudio(data?.audio_settings, data?.audio_settings_updated_at ?? null)
      } else if (deps.audio.getState().updatedAt > serverAt) {
        await push()
      }
    })().catch(() => undefined)
    cleanups.push(
      deps.audio.subscribe((state, prev) => {
        if (state.updatedAt === prev.updatedAt || state.updatedAt === adoptedAt || stopped) return
        if (audioTimer !== null) timers.clear(audioTimer)
        audioTimer = timers.set(() => {
          audioTimer = null
          void push().catch(() => undefined)
        }, AUDIO_DEBOUNCE_MS)
      }),
      () => {
        if (audioTimer !== null) timers.clear(audioTimer)
      },
    )
  }

  const ready = (async () => {
    const session = await deps.client.auth.getSession()
    const userId = session.data.session?.user.id
    token = session.data.session?.access_token ?? null
    if (userId === undefined || stopped) return
    meta = readMeta(userId)
    writeMeta({})
    const auth = deps.client.auth.onAuthStateChange((_event, next) => {
      token = next?.access_token ?? null
    })
    cleanups.push(() => auth.data.subscription.unsubscribe())
    await restore()
    cleanups.push(
      game.subscribe((state, prev) => {
        if (
          state.player !== prev.player ||
          state.goals !== prev.goals ||
          state.grants !== prev.grants ||
          state.prestige !== prev.prestige ||
          state.events !== prev.events ||
          state.actions !== prev.actions ||
          state.speed !== prev.speed
        ) {
          schedule()
        }
      }),
      deps.onOnline(() => {
        failures = 0
        void flush()
      }),
      deps.onLeave(() => {
        if (changed()) void flush(true)
      }),
    )
    startAudioSync()
    if (blocked === null) await flush()
  })().catch((error: unknown) => {
    logger.error('Cloud save sync failed to start', {
      error: error instanceof Error ? error.name : typeof error,
    })
  })

  return {
    ready,
    stop() {
      stopped = true
      clearPending()
      if (retryTimer !== null) timers.clear(retryTimer)
      for (const cleanup of cleanups.splice(0)) cleanup()
      status.setState({ controls: null })
    },
  }
}
