import { describe, expect, it } from 'vitest'
import { bearerToken, isModerator, parseModeratorEmails, tokenSignInMethods } from './auth'

describe('parseModeratorEmails', () => {
  it('reads a comma-separated list, trimmed and lower-cased', () => {
    expect([...parseModeratorEmails(' Boss@Example.test , mod2@example.test,')]).toEqual([
      'boss@example.test',
      'mod2@example.test',
    ])
  })

  it('means nobody when missing, empty or only junk (never a wildcard)', () => {
    expect(parseModeratorEmails(undefined).size).toBe(0)
    expect(parseModeratorEmails('').size).toBe(0)
    expect(parseModeratorEmails(' , ,').size).toBe(0)
    expect(parseModeratorEmails('*,@example.test,not-an-email').size).toBe(0)
  })
})

describe('isModerator', () => {
  const allowed = parseModeratorEmails('boss@example.test')
  const mod = {
    id: 'm',
    email: 'BOSS@example.test',
    email_confirmed_at: '2026-10-01T00:00:00Z',
    is_anonymous: false,
  }

  it('accepts a confirmed, permanent account on the list (any case)', () => {
    expect(isModerator(mod, allowed)).toBe(true)
  })

  it('refuses guests, unconfirmed emails, missing emails and anyone not listed', () => {
    expect(isModerator({ ...mod, is_anonymous: true }, allowed)).toBe(false)
    expect(isModerator({ ...mod, email_confirmed_at: null }, allowed)).toBe(false)
    expect(isModerator({ ...mod, email: null }, allowed)).toBe(false)
    expect(isModerator({ ...mod, email: 'boss@example.test.evil' }, allowed)).toBe(false)
    expect(isModerator(mod, new Set())).toBe(false)
  })
})

describe('bearerToken', () => {
  it('reads only a well-formed Bearer header', () => {
    expect(bearerToken('Bearer abc.def-ghi_jkl')).toBe('abc.def-ghi_jkl')
    expect(bearerToken('bearer abc')).toBeNull()
    expect(bearerToken('Bearer ')).toBeNull()
    expect(bearerToken('Basic abc')).toBeNull()
    expect(bearerToken(null)).toBeNull()
    expect(bearerToken('Bearer a b')).toBeNull()
  })
})

describe('tokenSignInMethods', () => {
  const token = (payload: unknown) =>
    `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
  it('reads the amr methods, and nothing from a token it cannot read', () => {
    expect(tokenSignInMethods(token({ amr: [{ method: 'otp', timestamp: 1 }] }))).toEqual(['otp'])
    expect(tokenSignInMethods(token({ amr: 'otp' }))).toEqual([])
    expect(tokenSignInMethods(token({}))).toEqual([])
    expect(tokenSignInMethods('no-dots')).toEqual([])
    expect(tokenSignInMethods('h.%%%.s')).toEqual([])
  })
})
