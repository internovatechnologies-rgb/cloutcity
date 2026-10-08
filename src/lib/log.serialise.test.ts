import { describe, expect, it } from 'vitest'
import { REDACTED, redact, scrub } from './log'

describe('redact: non-plain values keep their content', () => {
  it('serialises Dates to ISO strings', () => {
    expect(redact({ at: new Date('2026-10-06T12:00:00.000Z'), bad: new Date('nope') })).toEqual({
      at: '2026-10-06T12:00:00.000Z',
      bad: 'Invalid Date',
    })
  })

  it('turns Maps into objects and Sets into arrays, redacting their contents', () => {
    const out = redact({
      byZone: new Map<string, unknown>([
        ['astoria', 3],
        ['token', 'secret'],
      ]),
      tags: new Set(['solo', 'kid@example.com']),
    })
    expect(out).toEqual({
      byZone: { astoria: 3, token: REDACTED },
      tags: ['solo', REDACTED],
    })
  })

  it('keeps an object that appears twice without a cycle', () => {
    const shared = { id: 1 }
    expect(redact({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } })
  })
})

describe('redact: Map keys', () => {
  it('serialises non-string keys deterministically so entries are not lost', () => {
    const out = redact(
      new Map<unknown, unknown>([
        [{ zone: 'astoria' }, 1],
        [{ zone: 'flushing' }, 2],
        [7, 'seven'],
      ]),
    )
    expect(out).toEqual({ '{"zone":"astoria"}': 1, '{"zone":"flushing"}': 2, '7': 'seven' })
  })

  it('suffixes keys that collide after redaction', () => {
    const out = redact(
      new Map([
        ['a@example.com', 1],
        ['b@example.com', 2],
      ]),
    )
    expect(out).toEqual({ [REDACTED]: 1, [`${REDACTED}#2`]: 2 })
  })
})

describe('scrub: URLs', () => {
  it('handles absolute URLs, relative paths and bare query strings in longer text', () => {
    expect(scrub('GET https://x.example/cb?code=abc&state=ok failed')).toBe(
      `GET https://x.example/cb?code=${REDACTED}&state=ok failed`,
    )
    expect(scrub('/reset?Password=hunter2#k=1')).toBe(`/reset?Password=${REDACTED}#k=1`)
    expect(scrub('params: api_key=K123&page=2')).toBe(`params: api_key=${REDACTED}&page=2`)
    expect(scrub('email=KID%40Example.COM')).toBe(`email=${REDACTED}`)
    expect(scrub('/u?who=kid%40example.com')).toBe(`/u?who=${REDACTED}`)
  })

  it('leaves ordinary parameters alone', () => {
    expect(scrub('/live?zone=astoria-1&page=2#top')).toBe('/live?zone=astoria-1&page=2#top')
  })
})
