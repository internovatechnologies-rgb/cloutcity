import { describe, expect, it } from 'vitest'
import { HandlesConfigSchema } from '@/lib/data/schemas/config'
import { normaliseHandleInput } from '@/lib/handles/normalise'
import { fieldErrors } from './errors'
import {
  HANDLE_PATTERN,
  MyProfileSchema,
  createHandleSchema,
  handlesConfig,
  parseHandleCheckStatus,
} from './handle'

const schema = createHandleSchema()
const errorFor = (handle: string) => fieldErrors(schema, { handle }).handle

describe('handle form schema', () => {
  it('uses the validated config', () => {
    expect(HandlesConfigSchema.parse(handlesConfig)).toEqual(handlesConfig)
  })

  it.each([
    ['', 'profile.handle.error.tooShort'],
    ['ab', 'profile.handle.error.tooShort'],
    ['abcdefghijklmnopq', 'profile.handle.error.tooLong'],
    ['ab c', 'profile.handle.error.characters'],
    ['José', 'profile.handle.error.characters'],
    ['9lives', 'profile.handle.error.start'],
    ['_abc', 'profile.handle.error.start'],
    ['a__b', 'profile.handle.error.underscores'],
    ['abc_', 'profile.handle.error.underscores'],
    ['A123', 'profile.handle.error.letters'],
  ])('%j shows %s', (handle, key) => {
    expect(errorFor(handle)).toBe(key)
  })

  it('accepts valid handles', () => {
    for (const handle of ['Abc', 'Cool_Cat', 'SwiftTaxi42', 'abcdefghijklmnop']) {
      expect(errorFor(handle), handle).toBeUndefined()
    }
  })

  it('accepts exactly what HANDLE_PATTERN (the database rule) accepts', () => {
    const alphabet = ['a', 'B', '1', '_', '-', ' ']
    const samples = ['']
    for (let length = 1; length <= 4; length += 1) {
      const next: string[] = []
      for (const prefix of samples.filter((s) => s.length === length - 1)) {
        for (const char of alphabet) next.push(prefix + char)
      }
      samples.push(...next)
    }
    samples.push('abcdefghijklmnop', 'abcdefghijklmnopq', 'a_b_c_d_e_f_g_h1', 'A1_2_3')
    const disagree = samples.filter(
      (handle) => (errorFor(handle) === undefined) !== HANDLE_PATTERN.test(handle),
    )
    expect(disagree).toEqual([])
  })

  it('the normalised preview of typical input passes', () => {
    for (const typed of ['Cool Cat', 'the.real-deal', 'Renée 99']) {
      expect(errorFor(normaliseHandleInput(typed)), typed).toBeUndefined()
    }
  })
})

describe('handle RPC answers', () => {
  it('reads check_handle statuses and nothing else', () => {
    expect(parseHandleCheckStatus('available')).toBe('available')
    expect(parseHandleCheckStatus('not_allowed')).toBe('not_allowed')
    expect(parseHandleCheckStatus('maybe')).toBeNull()
    expect(parseHandleCheckStatus(null)).toBeNull()
  })

  it('reads a get_my_profile row', () => {
    const row = {
      handle: 'SwiftTaxi42',
      public_level: 'nobody',
      career_path: null,
      avatar: {},
      handle_generated: true,
      free_handle_change: true,
      handle_changes_left: 2,
      next_handle_change_at: null,
    }
    expect(MyProfileSchema.parse(row)).toEqual(row)
    expect(MyProfileSchema.safeParse({ ...row, handle_changes_left: -1 }).success).toBe(false)
  })
})
