import { describe, expect, it } from 'vitest'
import { TEXT_FILTER_FIXTURES } from './textFilter.fixtures'
import { containsContactInfo, normalizeText } from './textFilter'

describe('normalizeText', () => {
  it.each(TEXT_FILTER_FIXTURES.map((f) => [f.text, f.normalized]))(
    '%j normalises to %j',
    (text, normalized) => {
      expect(normalizeText(text)).toBe(normalized)
    },
  )

  it('lower-cases ASCII letters only, so it agrees with the database whatever its locale', () => {
    expect(normalizeText('ABC İ Ü')).toBe('abc İ Ü')
  })
})

describe('containsContactInfo', () => {
  it.each(TEXT_FILTER_FIXTURES.map((f) => [f.text, f.contact]))('%j → %s', (text, contact) => {
    expect(containsContactInfo(text)).toBe(contact)
  })

  it('allows insults and slurs: a report note is evidence', () => {
    expect(containsContactInfo('he called me a bastard and worse')).toBe(false)
  })

  it('catches a link split by a zero-width space that the patterns alone would miss', () => {
    const hidden = 'evil\u200b.com'
    expect(containsContactInfo(hidden)).toBe(true)
    expect(containsContactInfo(hidden.replace('\u200b', ''))).toBe(true)
  })

  it('has fixtures on both sides of every rule', () => {
    expect(TEXT_FILTER_FIXTURES.filter((f) => f.contact).length).toBeGreaterThan(10)
    expect(TEXT_FILTER_FIXTURES.filter((f) => !f.contact).length).toBeGreaterThan(5)
  })
})
