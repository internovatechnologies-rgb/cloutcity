import { describe, expect, it } from 'vitest'
import { createLogger, type LogRecord } from '@/lib/log'
import type { AuthUserLike } from './auth'
import {
  ModActionSchema,
  handleAction,
  handleCase,
  handleQueue,
  handleSignIn,
  modUrlFrom,
  rpcForAction,
  statusOfRpcError,
  type ModRouteDeps,
  type ModRpcResponse,
} from './handlers'
import { createRateLimiter } from './rateLimit'

const MOD_EMAIL = 'Boss@Example.test'
const MOD: AuthUserLike = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'boss@example.test',
  email_confirmed_at: '2026-10-01T00:00:00Z',
  is_anonymous: false,
}
const CASE = '22222222-2222-4222-8222-222222222222'
const NOTE = 'the secret moderator note'

/** A token shaped like Supabase's: the payload's `amr` says how the session was signed in. */
const jwt = (name: string, method = 'otp') =>
  [
    'eyJhbGciOiJIUzI1NiJ9',
    Buffer.from(JSON.stringify({ sub: name, amr: [{ method, timestamp: 1 }] })).toString(
      'base64url',
    ),
    name,
  ].join('.')

const TOKEN = {
  mod: jwt('mod'),
  modByPassword: jwt('mod-password', 'password'),
  modFromGuest: jwt('mod-guest', 'anonymous'),
  player: jwt('player'),
  guest: jwt('guest', 'anonymous'),
  unconfirmed: jwt('unconfirmed'),
} as const

const USERS: Readonly<Record<string, AuthUserLike>> = {
  [TOKEN.mod]: MOD,
  // The moderator's address claimed with a password, or a guest that set it as its email: with
  // email confirmations off, Supabase marks it confirmed without anyone reading the inbox.
  [TOKEN.modByPassword]: MOD,
  [TOKEN.modFromGuest]: MOD,
  [TOKEN.player]: { ...MOD, id: 'p', email: 'player@example.test' },
  [TOKEN.guest]: { id: 'g', email: null, is_anonymous: true },
  [TOKEN.unconfirmed]: { ...MOD, email_confirmed_at: null },
}

function setup(patch: Partial<ModRouteDeps> = {}) {
  const records: LogRecord[] = []
  const rpcCalls: { fn: string; args: Readonly<Record<string, unknown>> }[] = []
  const sent: { email: string; redirectTo: string }[] = []
  const scheduled: (() => Promise<void>)[] = []
  let ids = 0
  let rpcAnswer: ModRpcResponse = { data: { done: true }, error: null }
  const deps: ModRouteDeps = {
    configured: true,
    modUrl: 'https://cloutcity.example/mod',
    allowed: new Set(['boss@example.test']),
    getUser: (token) => Promise.resolve(USERS[token] ?? null),
    rpc: (fn, args) => {
      rpcCalls.push({ fn, args })
      return Promise.resolve(rpcAnswer)
    },
    sendSignInLink: (email, redirectTo) => {
      sent.push({ email, redirectTo })
      return Promise.resolve()
    },
    afterResponse: (task) => scheduled.push(task),
    signInLimiter: createRateLimiter(3, 60_000),
    queueLimit: 50,
    now: () => 1_000,
    logger: createLogger({ level: 'debug', sink: (record) => records.push(record) }),
    newCorrelationId: () => `corr-${++ids}`,
    ...patch,
  }
  return {
    deps,
    records,
    rpcCalls,
    sent,
    scheduled,
    answer: (next: ModRpcResponse) => {
      rpcAnswer = next
    },
  }
}

const get = (path: string, token?: string) =>
  new Request(`http://localhost:3102${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })

const post = (path: string, body: unknown, token?: string, ip = '203.0.113.9') =>
  new Request(`http://localhost:3102${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })

const suspend = {
  action: 'suspend',
  caseId: CASE,
  idempotencyKey: 'key-0001-abcd',
  reason: 'harassment',
  days: 7,
  note: NOTE,
}

describe('/api/mod sign-in', () => {
  it('answers the same 202 for a moderator and anyone else, and sends only the moderator a link', async () => {
    const { deps, sent, scheduled } = setup()
    const forMod = await handleSignIn(post('/api/mod/sign-in', { email: MOD_EMAIL }), deps)
    const forOther = await handleSignIn(
      post('/api/mod/sign-in', { email: 'nobody@example.test' }),
      deps,
    )
    expect(forMod.status).toBe(202)
    expect(forOther.status).toBe(202)
    expect(await forMod.json()).toEqual(await forOther.json())
    // The link goes out after the response, so timing reveals nothing either.
    expect(sent).toEqual([])
    await Promise.all(scheduled.map((task) => task()))
    expect(sent).toEqual([{ email: MOD_EMAIL, redirectTo: 'https://cloutcity.example/mod' }])
  })

  it('builds the link from the configured site, never from the request host', async () => {
    const { deps, sent, scheduled } = setup()
    const spoofed = new Request('https://attacker.example/api/mod/sign-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'attacker.example',
        'x-forwarded-host': 'attacker.example',
      },
      body: JSON.stringify({ email: MOD_EMAIL }),
    })
    expect((await handleSignIn(spoofed, deps)).status).toBe(202)
    await Promise.all(scheduled.map((task) => task()))
    expect(sent).toEqual([{ email: MOD_EMAIL, redirectTo: 'https://cloutcity.example/mod' }])
  })

  it('fails closed, the same for everyone, when the site URL is not configured', async () => {
    const { deps, scheduled } = setup({ modUrl: null })
    const forMod = await handleSignIn(post('/api/mod/sign-in', { email: MOD_EMAIL }), deps)
    const forOther = await handleSignIn(
      post('/api/mod/sign-in', { email: 'nobody@example.test' }),
      deps,
    )
    expect(forMod.status).toBe(503)
    expect(await forMod.json()).toEqual(await forOther.json())
    expect(scheduled).toEqual([])
  })

  it('is private and never cached', async () => {
    const { deps } = setup()
    const response = await handleSignIn(post('/api/mod/sign-in', { email: MOD_EMAIL }), deps)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-robots-tag')).toMatch(/noindex/)
    expect(response.headers.get('x-correlation-id')).toBe('corr-1')
  })

  it('rate limits per client IP', async () => {
    const { deps } = setup()
    const statuses: number[] = []
    for (let i = 0; i < 4; i += 1) {
      statuses.push(
        (await handleSignIn(post('/api/mod/sign-in', { email: 'x@example.test' }), deps)).status,
      )
    }
    expect(statuses).toEqual([202, 202, 202, 429])
    const otherIp = post('/api/mod/sign-in', { email: 'x@example.test' }, undefined, '198.51.100.1')
    expect((await handleSignIn(otherIp, deps)).status).toBe(202)
  })

  it('refuses a body that is not one email', async () => {
    const { deps } = setup()
    for (const body of [{}, { email: 'not-an-email' }, { email: MOD_EMAIL, extra: 1 }]) {
      expect((await handleSignIn(post('/api/mod/sign-in', body), deps)).status).toBe(400)
    }
  })

  it('fails closed when the server has no Supabase service configuration', async () => {
    const { deps, scheduled } = setup({ configured: false })
    const response = await handleSignIn(post('/api/mod/sign-in', { email: MOD_EMAIL }), deps)
    expect(response.status).toBe(503)
    expect(scheduled).toEqual([])
  })

  it('never logs the email', async () => {
    const { deps, records, scheduled } = setup({
      sendSignInLink: () => Promise.reject(new Error(`could not send to ${MOD_EMAIL}`)),
    })
    await handleSignIn(post('/api/mod/sign-in', { email: MOD_EMAIL }), deps)
    await Promise.all(scheduled.map((task) => task()))
    expect(records.length).toBeGreaterThan(0)
    expect(JSON.stringify(records).toLowerCase()).not.toContain('boss@example.test')
  })
})

describe('/api/mod auth matrix', () => {
  const routes = {
    queue: (deps: ModRouteDeps, token?: string) => handleQueue(get('/api/mod/queue', token), deps),
    case: (deps: ModRouteDeps, token?: string) =>
      handleCase(get(`/api/mod/case/${CASE}`, token), CASE, deps),
    action: (deps: ModRouteDeps, token?: string) =>
      handleAction(post('/api/mod/action', suspend, token), deps),
  }

  for (const [name, call] of Object.entries(routes)) {
    it(`${name}: 401 without a valid token, 403 for anyone not a confirmed moderator, 200 for one`, async () => {
      const { deps, rpcCalls } = setup()
      expect((await call(deps)).status).toBe(401)
      expect((await call(deps, 'forged-token')).status).toBe(401)
      expect((await call(deps, TOKEN.player)).status).toBe(403)
      expect((await call(deps, TOKEN.guest)).status).toBe(403)
      expect((await call(deps, TOKEN.unconfirmed)).status).toBe(403)
      expect(rpcCalls).toEqual([])
      expect((await call(deps, TOKEN.mod)).status).toBe(200)
      expect(rpcCalls).toHaveLength(1)
    })

    it(`${name}: the moderator's address is not enough without proof of the inbox (a password or guest session is a 403)`, async () => {
      const { deps, rpcCalls } = setup()
      expect((await call(deps, TOKEN.modByPassword)).status).toBe(403)
      expect((await call(deps, TOKEN.modFromGuest)).status).toBe(403)
      expect(rpcCalls).toEqual([])
    })

    it(`${name}: an empty MODERATOR_EMAILS lets nobody in`, async () => {
      const { deps } = setup({ allowed: new Set() })
      expect((await call(deps, TOKEN.mod)).status).toBe(403)
    })

    it(`${name}: a failing token lookup is a 401`, async () => {
      const { deps } = setup({ getUser: () => Promise.reject(new Error('auth down')) })
      expect((await call(deps, TOKEN.mod)).status).toBe(401)
    })
  }
})

describe('/api/mod queue, case and action', () => {
  it('queue passes the moderator id and the configured limit', async () => {
    const { deps, rpcCalls } = setup()
    const response = await handleQueue(get('/api/mod/queue', TOKEN.mod), deps)
    expect(await response.json()).toEqual({ ok: true, data: { done: true } })
    expect(rpcCalls).toEqual([{ fn: 'mod_queue', args: { p_moderator_id: MOD.id, p_limit: 50 } }])
  })

  it('case refuses an id that is not a uuid', async () => {
    const { deps, rpcCalls } = setup()
    const response = await handleCase(get('/api/mod/case/x', TOKEN.mod), "x' or 1=1", deps)
    expect(response.status).toBe(400)
    expect(rpcCalls).toEqual([])
  })

  it('action calls the mod_* RPC with the moderator, idempotency key and correlation id', async () => {
    const { deps, rpcCalls } = setup()
    const response = await handleAction(post('/api/mod/action', suspend, TOKEN.mod), deps)
    expect(response.status).toBe(200)
    expect(rpcCalls).toEqual([
      {
        fn: 'mod_suspend',
        args: {
          p_moderator_id: MOD.id,
          p_case: CASE,
          p_idempotency_key: 'key-0001-abcd',
          p_correlation_id: 'corr-1',
          p_note: NOTE,
          p_reason: 'harassment',
          p_days: 7,
        },
      },
    ])
  })

  it('action refuses unknown actions, bad keys, out-of-range days and extra fields', async () => {
    const { deps, rpcCalls } = setup()
    for (const body of [
      { ...suspend, action: 'delete_everything' },
      { ...suspend, idempotencyKey: 'short' },
      { ...suspend, days: 0 },
      { ...suspend, days: 366 },
      { ...suspend, reason: 'vibes' },
      { ...suspend, moderatorId: 'someone-else' },
      { ...suspend, note: 'x'.repeat(501) },
    ]) {
      expect((await handleAction(post('/api/mod/action', body, TOKEN.mod), deps)).status).toBe(400)
    }
    expect(rpcCalls).toEqual([])
  })

  it('maps an RPC refusal to its status and code: 409 already_resolved', async () => {
    const { deps, answer, records } = setup()
    answer({ data: null, error: { code: 'PT409', message: 'already_resolved' } })
    const response = await handleAction(post('/api/mod/action', suspend, TOKEN.mod), deps)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, code: 'already_resolved' })
    // The note goes to the database (the audit row), never to the logs.
    expect(JSON.stringify(records)).not.toContain(NOTE)
  })

  it('an unexpected database error is a 500 with no detail', async () => {
    const { deps, answer } = setup()
    answer({ data: null, error: { code: '42P01', message: 'relation "x" does not exist' } })
    const response = await handleQueue(get('/api/mod/queue', TOKEN.mod), deps)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, code: 'unknown' })
  })
})

describe('rpcForAction', () => {
  const key = 'key-0001-abcd'
  const parse = (body: unknown) => ModActionSchema.parse(body)
  it('maps every action to its RPC and drops a blank note', () => {
    expect(
      rpcForAction(
        parse({ action: 'dismiss', caseId: CASE, idempotencyKey: key, abusive: true, note: '  ' }),
        'm',
        'c',
      ),
    ).toEqual({
      fn: 'mod_dismiss',
      args: {
        p_moderator_id: 'm',
        p_case: CASE,
        p_idempotency_key: key,
        p_correlation_id: 'c',
        p_abusive: true,
      },
    })
    for (const action of ['warn', 'reset_handle', 'ban'] as const) {
      expect(
        rpcForAction(parse({ action, caseId: CASE, idempotencyKey: key, reason: 'spam' }), 'm', 'c')
          .fn,
      ).toBe(`mod_${action}`)
    }
    expect(
      rpcForAction(
        parse({ action: 'resolve_appeal', caseId: CASE, idempotencyKey: key, overturn: false }),
        'm',
        'c',
      ).args,
    ).toMatchObject({ p_overturn: false })
    expect(
      rpcForAction(
        parse({ action: 'set_legal_hold', caseId: CASE, idempotencyKey: key, hold: true }),
        'm',
        'c',
      ).args,
    ).toMatchObject({ p_hold: true })
  })
})

describe('statusOfRpcError', () => {
  it('reads PTxyz as HTTP xyz and anything else as 500', () => {
    expect(statusOfRpcError({ code: 'PT403' })).toBe(403)
    expect(statusOfRpcError({ code: 'PT404' })).toBe(404)
    expect(statusOfRpcError({ code: 'P0001' })).toBe(500)
    expect(statusOfRpcError({})).toBe(500)
  })
})

describe('modUrlFrom', () => {
  it('is the /mod page of the configured origin, or null', () => {
    expect(modUrlFrom('https://cloutcity.example')).toBe('https://cloutcity.example/mod')
    expect(modUrlFrom(' https://cloutcity.example/some/path?x=1 ')).toBe(
      'https://cloutcity.example/mod',
    )
    expect(modUrlFrom('http://localhost:3112')).toBe('http://localhost:3112/mod')
    for (const bad of [
      undefined,
      '',
      '  ',
      'cloutcity.example',
      'javascript:alert(1)',
      'ftp://x',
    ]) {
      expect(modUrlFrom(bad)).toBeNull()
    }
  })
})
