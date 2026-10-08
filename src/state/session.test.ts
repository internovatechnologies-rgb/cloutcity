/**
 * The guest session (S05): synchronous and local at once, then an anonymous Supabase session in
 * the background, only after the 18+ attestation, only with a configuration, only once the map
 * is playable, and at most once per page. Every failure degrades to local play.
 */
import { describe, expect, it, vi } from 'vitest'
import onboardingJson from '@data/config/onboarding.json'
import { createLogger, type LogRecord } from '@/lib/log'
import type { AttestationArgs } from '@/lib/supabase/attestation'
import type { SupabaseEnv } from '@/lib/supabase/env'
import type { ConnectResult } from '@/lib/supabase/supabaseAuth'
import { createGuestSessionStore } from './guestSession'
import { createOnboardingStore, type PersistedOnboarding } from './onboarding'
import { classifySessionFailure, createGuestSessionStarter, type GuestSessionDeps } from './session'
import { createSafeJsonStorage } from './storage'

const T0 = Date.UTC(2026, 9, 7, 12)
const ENV: SupabaseEnv = { url: 'http://127.0.0.1:54321', anonKey: 'anon-key' }
const USER_ID = '6f1c2a7e-0000-4000-8000-000000000001'

/** Lets every pending promise callback run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(options: { env?: SupabaseEnv | null; online?: boolean } = {}) {
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) })
  const onboarding = createOnboardingStore(
    createSafeJsonStorage<PersistedOnboarding>(() => undefined, logger),
    onboardingJson,
    logger,
  )
  const status = createGuestSessionStore()
  let markPlayable: () => void = () => {}
  const playable = new Promise<void>((resolve) => (markPlayable = resolve))
  const results: ConnectResult[] = []
  const connectAnonymous = vi.fn<
    (env: SupabaseEnv, args: AttestationArgs) => Promise<ConnectResult>
  >(async () => results.shift() ?? { ok: true, reused: false })
  const loadAuth = vi.fn(async () => ({ connectAnonymous }))
  const startSync = vi.fn(async () => {})
  let online = options.online ?? true
  let onlineListener: (() => void) | undefined
  const deps: GuestSessionDeps = {
    env: () => (options.env === undefined ? ENV : options.env),
    whenMapPlayable: () => playable,
    loadAuth,
    startSync,
    isOnline: () => online,
    onceOnline: (listener) => {
      onlineListener = listener
      return () => (onlineListener = undefined)
    },
    status,
    onConnected: vi.fn(),
  }
  const start = createGuestSessionStarter(onboarding, logger, deps)
  return {
    records,
    onboarding,
    status,
    start,
    results,
    connectAnonymous,
    startSync,
    loadAuth,
    onConnected: deps.onConnected,
    markPlayable,
    complete: () =>
      onboarding
        .getState()
        .completeAdult({ consentVersion: onboardingJson.consentVersion, audioChoice: 'ours' }, T0),
    goOnline: () => {
      online = true
      const listener = onlineListener
      onlineListener = undefined
      listener?.()
    },
    goOffline: () => (online = false),
    levels: (msg: RegExp) => records.filter((r) => msg.test(r.msg)).map((r) => r.level),
  }
}

describe('guest session (S05)', () => {
  it('without a configuration stays local and imports nothing', async () => {
    const s = setup({ env: null })
    s.complete()
    expect(s.start()).toEqual({ mode: 'local' })
    s.markPlayable()
    await flush()
    expect(s.loadAuth).not.toHaveBeenCalled()
    expect(s.status.getState()).toEqual({ status: 'local', reason: 'no-config', reused: false })
    expect(s.levels(/no Supabase configuration/)).toEqual(['info'])
  })

  it('refuses without a passing attestation and never imports Supabase', async () => {
    const s = setup()
    expect(s.start()).toEqual({ mode: 'refused' })
    s.onboarding.getState().refuseUnderAge(T0)
    expect(s.start()).toEqual({ mode: 'refused' })
    s.markPlayable()
    await flush()
    expect(s.loadAuth).not.toHaveBeenCalled()
    expect(s.status.getState().status).toBe('refused')
  })

  it('waits for the map to be playable before loading Supabase', async () => {
    const s = setup()
    s.complete()
    expect(s.start()).toEqual({ mode: 'local' })
    await flush()
    expect(s.loadAuth).not.toHaveBeenCalled()
    expect(s.status.getState().status).toBe('local')
    s.markPlayable()
    await flush()
    expect(s.loadAuth).toHaveBeenCalledTimes(1)
    expect(s.status.getState()).toEqual({ status: 'anonymous', reason: null, reused: false })
  })

  it('sends the attestation built from the welcome card, never the birth year', async () => {
    const s = setup()
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    const [env, args] = s.connectAnonymous.mock.calls[0] ?? []
    expect(env).toEqual(ENV)
    expect(args).toEqual({
      p_adult: true,
      p_attested_at: new Date(T0).toISOString(),
      p_consent_version: onboardingJson.consentVersion,
      p_consented_at: new Date(T0).toISOString(),
      p_audio_choice: 'ours',
    })
    expect(JSON.stringify(s.records)).not.toMatch(/birth/i)
  })

  it('reports a reused session', async () => {
    const s = setup()
    s.results.push({ ok: true, reused: true })
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    expect(s.status.getState()).toEqual({ status: 'anonymous', reason: null, reused: true })
    expect(s.records.find((r) => r.msg === 'Guest session connected')?.context).toEqual({
      reused: true,
    })
  })

  it('starts cloud save sync once connected, and only then (S18c)', async () => {
    const s = setup()
    s.complete()
    s.start()
    await flush()
    expect(s.startSync).not.toHaveBeenCalled()
    s.markPlayable()
    await flush()
    expect(s.startSync).toHaveBeenCalledTimes(1)
  })

  it('a sync chunk that fails to load logs at info and keeps the session', async () => {
    const s = setup()
    s.startSync.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    expect(s.status.getState().status).toBe('anonymous')
    const record = s.records.find((r) => r.msg.startsWith('Cloud save sync did not load'))
    expect(record?.level).toBe('info')
  })

  it('signs in at most once however often it is started', async () => {
    const s = setup()
    s.complete()
    const first = s.start()
    expect(s.start()).toBe(first)
    expect(s.start()).toBe(first)
    s.markPlayable()
    await flush()
    expect(s.connectAnonymous).toHaveBeenCalledTimes(1)
  })

  it('a rate limit (429) plays local at info and does not retry', async () => {
    const s = setup()
    s.results.push({
      ok: false,
      stage: 'session',
      failure: { name: 'AuthApiError', status: 429, code: 'over_request_rate_limit' },
    })
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    expect(s.status.getState()).toEqual({ status: 'local', reason: 'rate-limited', reused: false })
    expect(s.levels(/rate limited/)).toEqual(['info'])
    s.goOnline()
    await flush()
    expect(s.connectAnonymous).toHaveBeenCalledTimes(1)
  })

  it('no network plays local at info and retries once when the browser is back online', async () => {
    const s = setup({ online: false })
    const offline: ConnectResult = {
      ok: false,
      stage: 'session',
      failure: { name: 'AuthRetryableFetchError', status: 0, code: undefined },
    }
    s.results.push(offline, offline)
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    expect(s.status.getState()).toEqual({ status: 'local', reason: 'offline', reused: false })
    expect(s.levels(/No network/)).toEqual(['info'])

    s.goOnline()
    await flush()
    expect(s.connectAnonymous).toHaveBeenCalledTimes(2)
    // The retry failed too: no further retry.
    s.goOnline()
    await flush()
    expect(s.connectAnonymous).toHaveBeenCalledTimes(2)
  })

  it('the retry after coming back online can connect', async () => {
    const s = setup({ online: false })
    s.results.push({
      ok: false,
      stage: 'session',
      failure: { name: 'TypeError', status: undefined, code: undefined },
    })
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    s.goOnline()
    await flush()
    expect(s.status.getState().status).toBe('anonymous')
  })

  it('a failed session chunk counts as no network', async () => {
    const s = setup({ online: false })
    s.loadAuth.mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    expect(s.status.getState().reason).toBe('offline')
  })

  it('a session chunk that fails to load while the browser reports online counts as no network, and retries', async () => {
    const s = setup()
    // What Turbopack's runtime throws for a chunk it could not fetch (a flaky network, a deploy
    // that replaced the chunk): an Error named ChunkLoadError, with navigator.onLine still true.
    const chunkError = Object.assign(new Error('Failed to load chunk /_next/static/chunks/x.js'), {
      name: 'ChunkLoadError',
    })
    s.loadAuth.mockRejectedValueOnce(chunkError)
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    expect(s.status.getState()).toEqual({ status: 'local', reason: 'offline', reused: false })
    expect(s.levels(/No network/)).toEqual(['info'])
    expect(s.levels(/sign-in failed/)).toEqual([])

    s.goOnline()
    await flush()
    expect(s.status.getState().status).toBe('anonymous')
  })

  it('sign-ins switched off on the project warn and play local', async () => {
    const s = setup()
    s.results.push({
      ok: false,
      stage: 'session',
      failure: { name: 'AuthApiError', status: 422, code: 'anonymous_provider_disabled' },
    })
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    expect(s.status.getState()).toEqual({ status: 'local', reason: 'disabled', reused: false })
    expect(s.levels(/sign-in failed/)).toEqual(['warn'])
  })

  it('any other refusal warns and plays local', async () => {
    const s = setup()
    s.results.push({
      ok: false,
      stage: 'session',
      failure: { name: 'AuthApiError', status: 400, code: 'validation_failed' },
    })
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    expect(s.status.getState().reason).toBe('error')
    expect(s.levels(/sign-in failed/)).toEqual(['warn'])
  })

  it('an attestation the server refuses warns with its code and plays local', async () => {
    const s = setup()
    s.results.push({ ok: false, stage: 'attest', code: 'invalid_timestamp' })
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    expect(s.status.getState().reason).toBe('attestation-failed')
    const warning = s.records.find((r) => r.level === 'warn')
    expect(warning?.context).toEqual({ code: 'invalid_timestamp' })
  })

  it('never logs a user id or token', async () => {
    const s = setup()
    s.complete()
    s.start()
    s.markPlayable()
    await flush()
    const logged = JSON.stringify(s.records)
    expect(logged).not.toContain(USER_ID)
    expect(logged).not.toMatch(/user_?id|access_token|refresh_token|anon-key/i)
  })
})

describe('classifySessionFailure', () => {
  const f = (name: string, status?: number, code?: string) => ({ name, status, code })
  it.each([
    [f('AuthApiError', 429), true, 'rate-limited'],
    [f('AuthApiError', 400, 'over_request_rate_limit'), true, 'rate-limited'],
    [f('AuthApiError', 422, 'anonymous_provider_disabled'), true, 'disabled'],
    [f('AuthApiError', 422, 'signup_disabled'), true, 'disabled'],
    [f('AuthRetryableFetchError', 0), true, 'offline'],
    [f('TypeError'), true, 'offline'],
    [f('AuthApiError', 500), false, 'offline'],
    [f('AuthRetryableFetchError', 503), true, 'error'],
    [f('AuthApiError', 400, 'validation_failed'), true, 'error'],
  ] as const)('%o (online %s) → %s', (failure, online, expected) => {
    expect(classifySessionFailure(failure, online)).toBe(expected)
  })
})

describe('guest session: after connecting (S18b)', () => {
  it('loads the moderator notices once the session is connected, never before or on failure', async () => {
    const ok = setup()
    ok.complete()
    ok.start()
    await flush()
    expect(ok.onConnected).not.toHaveBeenCalled()
    ok.markPlayable()
    await flush()
    expect(ok.onConnected).toHaveBeenCalledTimes(1)

    const failed = setup()
    failed.results.push({ ok: false, stage: 'attest', code: 'unknown' })
    failed.complete()
    failed.start()
    failed.markPlayable()
    await flush()
    expect(failed.onConnected).not.toHaveBeenCalled()
  })
})
