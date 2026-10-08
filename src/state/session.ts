/**
 * The guest session. A Supabase anonymous session may start only after a passing 18+
 * attestation (CLAUDE.md "Auth model", "Age"); under-age and locked players never get one.
 *
 * `startGuestSession()` stays synchronous (the welcome card calls it inside the submit gesture):
 * it checks the attestation and reports a local session at once, so play never waits on the
 * network. On the first success it also starts connecting, once per page:
 *
 *  1. no Supabase configuration in this build → stays local (`no-config`), nothing is imported;
 *  2. waits until the map is playable, so the sign-in never competes with the map for bandwidth;
 *  3. imports src/lib/supabase/supabaseAuth.ts (and with it @supabase/supabase-js) lazily;
 *  4. reuses this device's session or signs in anonymously, then records the attestation;
 *  5. once connected, loads any moderator notices waiting for the player (S18b) and starts cloud
 *     save sync (src/state/cloudSync.ts, lazily, with the same session; S18c).
 *
 * Failures degrade to local play and never block it: a rate limit (429) or no network are
 * expected and logged at info (no network retries once when the browser comes back online);
 * sign-ins switched off, or any other refusal, are a misconfiguration and logged at warn. The
 * user id and tokens are never logged or kept here (src/state/guestSession.ts).
 */
import { toAttestationArgs } from '@/lib/supabase/attestation'
import { supabaseEnv, type SupabaseEnv } from '@/lib/supabase/env'
import type { AuthFailure, ConnectResult } from '@/lib/supabase/supabaseAuth'
import { log, type Logger } from '@/lib/log'
import { guestSessionStore, type GuestSessionReason, type GuestSessionStore } from './guestSession'
import { whenMapPlayable } from './mapPlayable'
import { onboardingStore, type OnboardingRecord, type OnboardingStore } from './onboarding'

export type GuestSessionResult =
  /** No passing attestation on this device: no session, no Supabase user. */
  | { readonly mode: 'refused' }
  /** Solo play on this device; a server session may follow in the background. */
  | { readonly mode: 'local' }

/** What the session needs from the browser and the network; injectable for tests. */
export interface GuestSessionDeps {
  readonly env: () => SupabaseEnv | null
  readonly whenMapPlayable: () => Promise<void>
  /** Loads the Supabase session module (the lazy chunk with supabase-js). */
  readonly loadAuth: () => Promise<{
    connectAnonymous: (
      env: SupabaseEnv,
      attestation: ReturnType<typeof toAttestationArgs>,
    ) => Promise<ConnectResult>
  }>
  /** Loads and starts cloud save sync (S18c) once the session is connected. */
  readonly startSync: () => Promise<void>
  readonly isOnline: () => boolean
  /** Calls `listener` once when the browser is next online; returns a way to cancel. */
  readonly onceOnline: (listener: () => void) => () => void
  readonly status: GuestSessionStore
  /**
   * Runs once the session is connected (S18b: loads the moderator notices shown at session
   * start). Its failures are its own; it never affects the session.
   */
  readonly onConnected?: () => void
}

export function browserSessionDeps(): GuestSessionDeps {
  return {
    env: () => supabaseEnv(),
    whenMapPlayable,
    loadAuth: () => import('@/lib/supabase/supabaseAuth'),
    startSync: () =>
      Promise.all([import('@/lib/supabase/supabaseAuth'), import('./cloudSync')]).then(
        ([auth, sync]) => {
          // The client connectAnonymous signed in with: the same session (supabaseAuth.ts).
          const env = supabaseEnv()
          sync.startCloudSync(env === null ? undefined : auth.supabaseClient(env))
        },
      ),
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
    onceOnline: (listener) => {
      window.addEventListener('online', listener, { once: true })
      return () => window.removeEventListener('online', listener)
    },
    status: guestSessionStore,
    onConnected: () => {
      void import('@/lib/safety/loadNotices')
        .then((module) => module.loadAccountNotices())
        .catch((error: unknown) => {
          log.info('Account notices did not load; they show next session', {
            error: error instanceof Error ? error.name : typeof error,
          })
        })
    },
  }
}

type Failure = Exclude<GuestSessionReason, 'no-config' | 'attestation-failed'>

/** Why a sign-in failed, from the error's status and Auth error code alone. */
export function classifySessionFailure(failure: AuthFailure, online: boolean): Failure {
  if (failure.status === 429 || failure.code === 'over_request_rate_limit') return 'rate-limited'
  if (failure.code === 'anonymous_provider_disabled' || failure.code === 'signup_disabled') {
    return 'disabled'
  }
  // supabase-js reports an unreachable network as a retryable fetch error with status 0; a
  // thrown fetch is a TypeError, and a session chunk the bundler could not fetch is a
  // ChunkLoadError (Turbopack), even while the browser still reports itself online.
  const unreachable =
    (failure.name === 'AuthRetryableFetchError' && !failure.status) ||
    failure.name === 'TypeError' ||
    failure.name === 'ChunkLoadError'
  if (!online || unreachable) return 'offline'
  return 'error'
}

/**
 * A session starter bound to one onboarding store. Once a session has started, later calls
 * return it again instead of starting another (the gate calls it on boot and on completion),
 * and the connection is attempted at most once (plus one retry when the network returns).
 */
export function createGuestSessionStarter(
  store: OnboardingStore,
  logger: Logger = log,
  deps: GuestSessionDeps = browserSessionDeps(),
) {
  let started: GuestSessionResult | undefined
  const setLocal = (reason: GuestSessionReason) =>
    deps.status.setState({ status: 'local', reason, reused: false })

  const connect = async (
    record: Extract<OnboardingRecord, { status: 'complete' }>,
    retry: boolean,
  ) => {
    const env = deps.env()
    if (env === null) {
      setLocal('no-config')
      logger.info('Playing local-only: this build has no Supabase configuration')
      return
    }
    const attestation = toAttestationArgs(record)
    await deps.whenMapPlayable()
    deps.status.setState({ status: 'connecting', reason: null, reused: false })

    let result: ConnectResult
    try {
      result = await (await deps.loadAuth()).connectAnonymous(env, attestation)
    } catch (error) {
      // The session chunk itself failed to load: the same as no network.
      result = {
        ok: false,
        stage: 'session',
        failure: {
          name: error instanceof Error ? error.name : typeof error,
          status: undefined,
          code: undefined,
        },
      }
    }

    if (result.ok) {
      deps.status.setState({ status: 'anonymous', reason: null, reused: result.reused })
      logger.info('Guest session connected', { reused: result.reused })
      deps.onConnected?.()
      deps.startSync().catch((error: unknown) => {
        // The sync chunk failed to load (offline): the save stays on this device.
        logger.info('Cloud save sync did not load; saving on this device only', {
          error: error instanceof Error ? error.name : typeof error,
        })
      })
      return
    }
    if (result.stage === 'attest') {
      setLocal('attestation-failed')
      logger.warn('Signed in, but the server did not record the 18+ attestation; playing local', {
        code: result.code,
      })
      return
    }
    const reason = classifySessionFailure(result.failure, deps.isOnline())
    setLocal(reason)
    const context = { reason, status: result.failure.status, code: result.failure.code }
    if (reason === 'rate-limited') {
      logger.info('Guest sign-in is rate limited; playing local', context)
    } else if (reason === 'offline') {
      logger.info('No network for the guest sign-in; playing local', context)
      if (retry) deps.onceOnline(() => void connect(record, false))
    } else {
      logger.warn('Guest sign-in failed; playing local', context)
    }
  }

  return function startGuestSession(): GuestSessionResult {
    if (started !== undefined) return started
    const record = store.getState().record
    if (record?.status !== 'complete') {
      deps.status.setState({ status: 'refused', reason: null, reused: false })
      logger.info('Not starting a guest session: no 18+ attestation on this device')
      return { mode: 'refused' }
    }
    started = { mode: 'local' }
    deps.status.setState({ status: 'local', reason: null, reused: false })
    logger.info('Guest session started', { mode: started.mode })
    void connect(record, true).catch((error: unknown) => {
      // connect handles every expected failure; anything left is a bug, but play goes on.
      setLocal('error')
      logger.error('The guest session failed unexpectedly; playing local', {
        error: error instanceof Error ? error.name : typeof error,
      })
    })
    return started
  }
}

/** Starts the guest session for this device's onboarding record. */
export const startGuestSession: () => GuestSessionResult =
  createGuestSessionStarter(onboardingStore)
