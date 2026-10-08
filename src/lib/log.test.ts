import { describe, expect, it } from 'vitest'
import { REDACTED, createLogger, redact, type LogRecord } from './log'

function capture() {
  const records: LogRecord[] = []
  return { records, sink: (record: LogRecord) => void records.push(record) }
}

const fixedNow = () => new Date('2026-10-06T12:00:00.000Z')

describe('createLogger', () => {
  it('writes structured records with level, time and correlation id', () => {
    const { records, sink } = capture()
    const logger = createLogger({ sink, now: fixedNow, correlationId: 'req-1', level: 'debug' })

    logger.info('shell rendered', { route: '/' })

    expect(records).toEqual([
      {
        level: 'info',
        msg: 'shell rendered',
        time: '2026-10-06T12:00:00.000Z',
        correlationId: 'req-1',
        context: { route: '/' },
      },
    ])
  })

  it('drops records below the configured level', () => {
    const { records, sink } = capture()
    const logger = createLogger({ sink, level: 'warn' })

    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d')

    expect(records.map((r) => r.level)).toEqual(['warn', 'error'])
  })

  it('generates a correlation id when none is given and lets children override it', () => {
    const { records, sink } = capture()
    const logger = createLogger({ sink, level: 'info' })
    expect(logger.correlationId).toMatch(/^[0-9a-f-]{32,36}$/)

    logger.withCorrelationId('flow-9').info('child')
    expect(records[0]?.correlationId).toBe('flow-9')
  })

  it('omits context when none is passed', () => {
    const { records, sink } = capture()
    createLogger({ sink, level: 'info' }).info('bare')
    expect(records[0]).not.toHaveProperty('context')
  })
})

describe('redact', () => {
  it('redacts sensitive keys at any depth and keeps the rest', () => {
    const out = redact({
      email: 'a@b.c',
      user: { accessToken: 't', handle: 'nyc_kid', chatText: 'hi' },
      list: [{ reportNote: 'n', reason: 'spam' }],
      Password: 'p',
      count: 3,
    })

    expect(out).toEqual({
      email: REDACTED,
      user: { accessToken: REDACTED, handle: 'nyc_kid', chatText: REDACTED },
      list: [{ reportNote: REDACTED, reason: 'spam' }],
      Password: REDACTED,
      count: 3,
    })
  })

  it('reduces errors to their name so messages cannot leak input', () => {
    expect(redact({ err: new TypeError('bad email a@b.c') })).toEqual({
      err: { name: 'TypeError' },
    })
  })

  it('truncates deeply nested values', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } }
    expect(redact(deep)).toEqual({ a: { b: { c: { d: { e: '[truncated]' } } } } })
  })
})

describe('redact: values a careless call site might pass (never log emails or tokens)', () => {
  it('redacts an email address held under an innocent key', () => {
    const out = JSON.stringify(
      redact({ user: 'kid@example.com', meta: { contact: 'a.b+qa@x.io' } }),
    )
    expect(out).not.toContain('kid@example.com')
    expect(out).not.toContain('a.b+qa@x.io')
  })

  it('redacts an email address embedded in a longer string value', () => {
    const out = JSON.stringify(redact({ detail: 'signup failed for kid@example.com today' }))
    expect(out).not.toContain('kid@example.com')
  })

  it('redacts bearer tokens and JWTs held under innocent keys', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const out = JSON.stringify(redact({ auth: `Bearer ${jwt}`, header: jwt }))
    expect(out).not.toContain(jwt)
  })

  it('keeps an email out of the record when it is interpolated into the message', () => {
    const { records, sink } = capture()
    createLogger({ sink, level: 'debug' }).error('magic link failed for kid@example.com')
    expect(JSON.stringify(records)).not.toContain('kid@example.com')
  })

  it('redacts sensitive keys inside arrays of objects at the top level', () => {
    expect(redact([{ token: 't', id: 1 }])).toEqual([{ token: REDACTED, id: 1 }])
  })

  it('keeps ordinary values intact', () => {
    expect(redact({ route: '/live', zone: 'astoria-1', count: 3, ok: true, none: null })).toEqual({
      route: '/live',
      zone: 'astoria-1',
      count: 3,
      ok: true,
      none: null,
    })
  })
})

describe('redact: hostile shapes', () => {
  it('does not throw on a circular object and the result is JSON-serialisable', () => {
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    loop.list = [loop]
    const out = redact(loop)
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('a logger call with a circular context reaches the sink without throwing', () => {
    const { records, sink } = capture()
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(() => createLogger({ sink, level: 'debug' }).warn('loop', { loop })).not.toThrow()
    expect(records).toHaveLength(1)
    expect(() => JSON.stringify(records[0])).not.toThrow()
  })

  it('redacts sensitive keys whatever the casing or separator', () => {
    expect(
      redact({
        EMAIL: 'x',
        user_email: 'x',
        'e-mail': 'x',
        refresh_token: 'x',
        AUTHORIZATION: 'x',
      }),
    ).toEqual({
      EMAIL: REDACTED,
      user_email: REDACTED,
      'e-mail': REDACTED,
      refresh_token: REDACTED,
      AUTHORIZATION: REDACTED,
    })
  })
})

describe('redact: cycle-1 probes (nested containers, URLs, shared references)', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

  it('scrubs strings inside nested arrays', () => {
    expect(redact({ rows: [['ok', ['kid@example.com']]] })).toEqual({
      rows: [['ok', [REDACTED]]],
    })
  })

  it('scrubs an email used as a Map key', () => {
    const out = JSON.stringify(redact({ byUser: new Map([['kid@example.com', 1]]) }))
    expect(out).not.toContain('kid@example.com')
  })

  it('treats a Map that contains itself as circular', () => {
    const map = new Map<string, unknown>()
    map.set('self', map)
    expect(redact({ map })).toEqual({ map: { self: '[circular]' } })
  })

  it('removes a JWT from a URL query string and fragment', () => {
    const out = JSON.stringify(
      redact({
        url: `https://cloutcity.example/cb?code=1&jwt=${jwt}&state=2`,
        redirect: `https://cloutcity.example/#access_token=${jwt}&type=magiclink`,
      }),
    )
    expect(out).not.toContain(jwt)
    expect(out).toContain('state=2')
  })

  it('removes a percent-encoded email from a logged URL', () => {
    const out = JSON.stringify(redact({ url: '/auth/callback?email=kid%40example.com&next=%2F' }))
    expect(out).not.toContain('kid%40example.com')
  })

  it('removes opaque token values from sensitive query parameters in a logged URL', () => {
    const out = JSON.stringify(
      redact({ url: '/cb#access_token=opaqueAbc123&refresh_token=r-xyz789&expires_in=3600' }),
    )
    expect(out).not.toContain('opaqueAbc123')
    expect(out).not.toContain('r-xyz789')
    expect(out).toContain('expires_in=3600')
  })

  it('keeps an object repeated in an array and at different depths', () => {
    const shared = { id: 1 }
    expect(redact({ list: [shared, shared], nested: { again: shared }, top: shared })).toEqual({
      list: [{ id: 1 }, { id: 1 }],
      nested: { again: { id: 1 } },
      top: { id: 1 },
    })
  })
})
