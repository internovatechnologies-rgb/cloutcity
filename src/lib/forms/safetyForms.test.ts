import { describe, expect, it } from 'vitest'
import { copy } from '@/lib/copy'
import { snakeToCamel } from '@/lib/copy/camel'
import { noticeKey, reportReasonKey, rpcErrorKey } from '@/lib/safety/errorCopy'
import { NOTICE_KINDS, REPORT_REASONS } from '@/lib/safety/reports'
import { RPC_ERRORS } from '@/lib/supabase/attestation'
import { createAppealSchema, isAppealable } from './appeal'
import { fieldErrors } from './errors'
import { handleCheckError, handleServerError } from './handle'
import '@/lib/copy/ns/profile'

describe('handle server errors (S18a part 2)', () => {
  it('maps every set_handle refusal to a field message', () => {
    expect(handleServerError('handle_taken', null).key).toBe('profile.handle.error.taken')
    expect(handleServerError('handle_not_allowed', null).key).toBe(
      'profile.handle.error.notAllowed',
    )
    expect(handleServerError('rate_limited', null).key).toBe('profile.handle.error.rateLimited')
    expect(handleServerError('unknown', null).key).toBe('profile.handle.error.failed')
    expect(handleServerError('account_suspended', null).key).toBe('safety.rpc.accountSuspended')
  })

  it('names the date the next change opens, or says later when it is unknown', () => {
    const limited = handleServerError('handle_change_limited', '2026-10-09T15:00:00Z')
    expect(limited.key).toBe('profile.handle.error.changeLimited')
    expect(copy(limited.key, limited.vars)).toMatch(/October (8|9|10), 2026/)
    expect(handleServerError('handle_change_limited', null).key).toBe(
      'profile.handle.error.changeLimitedSoon',
    )
    expect(handleServerError('handle_change_limited', 'garbage').key).toBe(
      'profile.handle.error.changeLimitedSoon',
    )
  })

  it('reads check_handle answers', () => {
    expect(handleCheckError('available', null)).toBeNull()
    expect(handleCheckError('taken', null)?.key).toBe('profile.handle.error.taken')
    expect(handleCheckError('current', null)?.key).toBe('profile.handle.error.sameAsCurrent')
    expect(handleCheckError('not_allowed', null)?.key).toBe('profile.handle.error.notAllowed')
  })
})

describe('safety copy keys', () => {
  it('every RPC error code, reason and notice kind has player-facing text', () => {
    for (const code of [...RPC_ERRORS, 'unknown' as const]) {
      expect(copy(rpcErrorKey(code)), code).not.toBe('')
    }
    for (const reason of REPORT_REASONS) expect(copy(reportReasonKey(reason))).not.toBe('')
    for (const kind of NOTICE_KINDS) expect(copy(noticeKey(kind))).not.toBe('')
  })

  it('snakeToCamel', () => {
    expect(snakeToCamel('sexual_content')).toBe('sexualContent')
    expect(snakeToCamel('not_authenticated')).toBe('notAuthenticated')
    expect(snakeToCamel('spam')).toBe('spam')
  })
})

describe('appeal form', () => {
  const schema = createAppealSchema(10)
  const errorFor = (body: string) => fieldErrors(schema, { body }).body

  it('needs words, at most the configured length', () => {
    expect(errorFor('')).toBe('safety.notice.appealEmpty')
    expect(errorFor('   ')).toBe('safety.notice.appealEmpty')
    expect(errorFor('0123456789')).toBeUndefined()
    expect(errorFor('01234567890')).toBe('safety.notice.appealTooLong')
  })

  it('only sanctions other than handle resets can be appealed', () => {
    expect(isAppealable({ kind: 'suspension', sanctionId: 's' })).toBe(true)
    expect(isAppealable({ kind: 'handle_reset', sanctionId: 's' })).toBe(false)
    expect(isAppealable({ kind: 'appeal_upheld', sanctionId: 's' })).toBe(false)
    expect(isAppealable({ kind: 'warning', sanctionId: null })).toBe(false)
  })
})
