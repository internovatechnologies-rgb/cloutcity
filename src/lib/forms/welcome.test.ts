import { describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import onboardingJson from '@data/config/onboarding.json'
import { copy, isCopyKey } from '@/lib/copy'
import { fieldErrors, firstInvalid } from './errors'
import {
  EMPTY_WELCOME_VALUES,
  WELCOME_FIELDS,
  createWelcomeSchema,
  type WelcomeValues,
} from './welcome'

const YEAR = 2026
const schema = createWelcomeSchema(YEAR, onboardingJson)
const valid: WelcomeValues = { birthYear: '1996', consent: true, audio: 'own' }
const errorsOf = (values: WelcomeValues) => fieldErrors(schema, values)

describe('welcome form schema', () => {
  it('reports all three errors at once on an empty form, as copy keys', () => {
    expect(errorsOf(EMPTY_WELCOME_VALUES)).toEqual({
      birthYear: 'welcome.birthYear.error',
      consent: 'welcome.consent.error',
      audio: 'welcome.audio.error',
    })
    expect(firstInvalid(WELCOME_FIELDS, errorsOf(EMPTY_WELCOME_VALUES))).toBe('birthYear')
  })

  it('every error key renders and names its field', () => {
    const errors = errorsOf(EMPTY_WELCOME_VALUES)
    expect(copy(errors.birthYear ?? 'welcome.title')).toMatch(/year you were born/i)
    expect(copy(errors.consent ?? 'welcome.title')).toMatch(/Terms.*Privacy Policy/)
    expect(copy(errors.audio ?? 'welcome.title')).toMatch(/sound/i)
  })

  it('accepts a complete form with no errors', () => {
    expect(errorsOf(valid)).toEqual({})
    expect(firstInvalid(WELCOME_FIELDS, {})).toBeUndefined()
  })

  it('drops only the error that was fixed', () => {
    expect(errorsOf({ ...EMPTY_WELCOME_VALUES, birthYear: '1990' })).toEqual({
      consent: 'welcome.consent.error',
      audio: 'welcome.audio.error',
    })
    const onlyAudio = errorsOf({ ...valid, audio: '' })
    expect(onlyAudio).toEqual({ audio: 'welcome.audio.error' })
    expect(firstInvalid(WELCOME_FIELDS, onlyAudio)).toBe('audio')
  })

  it('accepts exactly the years the picker offers', () => {
    expect(errorsOf({ ...valid, birthYear: String(YEAR) }).birthYear).toBeUndefined()
    expect(errorsOf({ ...valid, birthYear: String(YEAR - onboardingJson.birthYearSpan) })).toEqual(
      {},
    )
    for (const bad of [
      String(YEAR + 1),
      String(YEAR - onboardingJson.birthYearSpan - 1),
      '199',
      '19960',
      ' 1996',
      '1996.0',
      'abcd',
    ]) {
      expect(errorsOf({ ...valid, birthYear: bad }), bad).toEqual({
        birthYear: 'welcome.birthYear.error',
      })
    }
  })

  it('an under-age year is not a validation error (the card refuses it after)', () => {
    expect(errorsOf({ ...valid, birthYear: String(YEAR - 5) })).toEqual({})
  })

  it('rejects an unknown sound choice', () => {
    const values = { ...valid, audio: 'radio' } as unknown as WelcomeValues
    expect(errorsOf(values)).toEqual({ audio: 'welcome.audio.error' })
  })
})

describe('fieldErrors', () => {
  it('keeps the first issue per field', () => {
    const twoChecks = z.object({
      a: z.string().check(z.minLength(3, 'welcome.birthYear.error'), z.regex(/x/, 'welcome.title')),
    })
    expect(fieldErrors(twoChecks, { a: 'y' })).toEqual({ a: 'welcome.birthYear.error' })
  })

  it('throws when a schema message is not a copy key, rather than showing raw text', () => {
    const raw = z.object({ a: z.string().check(z.minLength(1, 'Required')) })
    expect(() => fieldErrors(raw, { a: '' })).toThrow(/not a copy key/)
  })

  it('every welcome error is a real copy key', () => {
    for (const key of Object.values(errorsOf(EMPTY_WELCOME_VALUES))) {
      expect(isCopyKey(key)).toBe(true)
    }
  })
})
