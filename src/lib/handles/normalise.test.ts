import { describe, expect, it } from 'vitest'
import {
  handleKey,
  handlePattern,
  handleSkeleton,
  normaliseHandleInput,
  squeezeRepeats,
} from './normalise'

const pattern = handlePattern({ minLength: 3, maxLength: 16, minLetters: 2 })

describe('handlePattern', () => {
  it.each(['Abc', 'a_b', 'Ab1', 'CoolCat99', 'Cool_Cat_99', 'abcdefghijklmnop', 'Ab_1'])(
    'accepts %s',
    (handle) => {
      expect(pattern.test(handle)).toBe(true)
    },
  )

  it.each([
    ['too short', 'ab'],
    ['too long', 'abcdefghijklmnopq'],
    ['a digit first', '1ab'],
    ['an underscore first', '_ab'],
    ['a trailing underscore', 'ab_'],
    ['a double underscore', 'a__b'],
    ['one letter only', 'A12'],
    ['a space', 'ab c'],
    ['an accent', 'Aéb'],
    ['a dash', 'ab-c'],
    ['an emoji', 'ab😀'],
    ['empty', ''],
  ])('refuses %s', (_why, handle) => {
    expect(pattern.test(handle)).toBe(false)
  })

  it('follows the configured lengths and letter count', () => {
    const strict = handlePattern({ minLength: 5, maxLength: 6, minLetters: 4 })
    expect(strict.test('Abcd')).toBe(false)
    expect(strict.test('Abcd1')).toBe(true)
    expect(strict.test('Abc12')).toBe(false)
    expect(strict.test('Abcdefg')).toBe(false)
  })
})

describe('handleKey', () => {
  it('ignores case and underscores, so look-alikes are one handle', () => {
    expect(handleKey('Cool_Cat')).toBe('coolcat')
    expect(handleKey('COOLCAT')).toBe(handleKey('cool_cat'))
    expect(handleKey('Ab_1_2')).toBe('ab12')
  })
})

describe('handleSkeleton', () => {
  it('reads leetspeak digits as letters and drops underscores', () => {
    expect(handleSkeleton('B4d_W0rd')).toBe('badword')
    expect(handleSkeleton('S7r33t')).toBe('street')
    expect(handleSkeleton('B1g9')).toBe('bigg')
    expect(handleSkeleton('Ab26')).toBe('ab26')
  })
})

describe('squeezeRepeats', () => {
  it('collapses runs of one character', () => {
    expect(squeezeRepeats('fuuun')).toBe('fun')
    expect(squeezeRepeats('aabbcc')).toBe('abc')
    expect(squeezeRepeats('abc')).toBe('abc')
  })
})

describe('normaliseHandleInput (the live preview)', () => {
  it.each([
    ['  Cool Cat  ', 'Cool_Cat'],
    ['cool.cat-99', 'cool_cat_99'],
    ['José', 'Jose'],
    ['Crème Brûlée', 'Creme_Brulee'],
    ['__a__b__', 'a_b'],
    ['hey!!you??', 'heyyou'],
    ['Ⓐbc', 'Abc'],
    ['ab😀cd', 'abcd'],
    ['', ''],
  ])('%j → %j', (input, preview) => {
    expect(normaliseHandleInput(input)).toBe(preview)
  })

  it('leaves a valid handle unchanged', () => {
    for (const handle of ['CoolCat99', 'a_b', 'Swift_Taxi']) {
      expect(normaliseHandleInput(handle)).toBe(handle)
    }
  })

  it('never invents a first letter: the form still explains what is wrong', () => {
    expect(normaliseHandleInput('99 problems')).toBe('99_problems')
    expect(pattern.test(normaliseHandleInput('99 problems'))).toBe(false)
  })
})
