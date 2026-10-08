import { describe, expect, it } from 'vitest'
import blocklistJson from '@data/moderation/handle-blocklist.json'
import handlesJson from '@data/config/handles.json'
import wordsJson from '@data/copy/handleWords.json'
import { HandlesConfigSchema } from '@/lib/data/schemas/config'
import { HandleBlocklistSchema, HandleWordsSchema } from '@/lib/data/schemas/handles'
import { allowOrder, flattenBlocklist, handleAllowed, type HandleTerms } from './filter'
import { handlePattern } from './normalise'

const terms = flattenBlocklist(HandleBlocklistSchema.parse(blocklistJson))
const words = HandleWordsSchema.parse(wordsJson)
const config = HandlesConfigSchema.parse(handlesJson)

describe('handleAllowed with the real blocklist', () => {
  it.each([
    ['profanity', 'Shithead'],
    ['leetspeak', 'Sh1tH34d'],
    ['leetspeak slur', 'F4gg0t'],
    ['stretched letters', 'Fuuuuck'],
    ['underscores between letters', 'F_u_c_k'],
    ['a slur inside other words', 'BigNazi_Fan'],
    ['staff', 'CloutCity_Staff'],
    ['staff with digits', 'Admin1'],
    ['a moderator', 'TheModerator'],
    ['a reserved word', 'Mod'],
    ['a reserved word with digits', 'Mod99'],
    ['a stretched reserved word', 'Admiin'],
    ['an agency', 'NYPD_Officer'],
    ['an agency in leetspeak', 'NYPD_0ff1cer'],
    ['the mayor', 'MayorOfQueens'],
    ['a brand', 'TikTokSupport'],
    ['a short brand', 'Apple'],
    ['a clout level', 'Icon'],
    ['a drug', 'CocaineKing'],
    ['a website path', 'Settings'],
    ['the allowlisted word with a term beside it', 'Cocktail_Cock'],
  ])('refuses %s (%s)', (_why, handle) => {
    expect(handleAllowed(handle, terms)).toBe(false)
  })

  it.each([
    'Badminton',
    'Cocktail',
    'Peacock',
    'Therapist',
    'Essex',
    'Scunthorpe',
    'Raccoon',
    'Skyscraper',
    'Montenegro',
    'Spicy',
    'Thorny',
    'Twinkle',
    'Glass',
    'Classic',
    'Cumin',
    'Title',
    'Button',
    'Among',
    'Spoon',
    'Modern',
    'Pineapple',
    'Metro',
    'Social',
    'CalmTaxi',
    'Bob',
    'Flagstaff',
    'DykerHeights',
  ])('allows %s', (handle) => {
    expect(handleAllowed(handle, terms)).toBe(true)
  })
})

describe('handleAllowed rules', () => {
  const sample: HandleTerms = {
    contains: ['bad', 'boob', 'gross'],
    exact: ['root', 'kkk', 'loot'],
    allow: ['badge', 'badger'],
  }

  it('exact terms refuse the whole handle, with or without trailing digits', () => {
    expect(handleAllowed('Root', sample)).toBe(false)
    expect(handleAllowed('Root_42', sample)).toBe(false)
    expect(handleAllowed('Rooty', sample)).toBe(true)
  })

  it('contains terms refuse anywhere, once allowlisted words are taken out', () => {
    expect(handleAllowed('SoBadNow', sample)).toBe(false)
    expect(handleAllowed('HoneyBadger', sample)).toBe(true)
    expect(handleAllowed('BadgeBad', sample)).toBe(false)
  })

  it('squeezed forms only meet terms without repeats of their own', () => {
    expect(handleAllowed('Baaad', sample)).toBe(false)
    // `boob` and `kkk` have repeats: squeezing must not turn them into `bob` or `k`.
    expect(handleAllowed('Bob', sample)).toBe(true)
    expect(handleAllowed('Kayak', sample)).toBe(true)
    expect(handleAllowed('Rooot', sample)).toBe(true)
    expect(handleAllowed('Lot', sample)).toBe(true)
  })

  it('strips longer allowlisted words first', () => {
    expect(allowOrder(['badge', 'badger', 'bat', 'ant'])).toEqual(['badger', 'badge', 'ant', 'bat'])
  })

  it('flattens the source groups into one sorted list per mode', () => {
    expect(
      flattenBlocklist({
        contains: { a: ['zz', 'bb'], b: ['bb', 'aa'] },
        exact: { c: ['qq'] },
        allow: ['yy', 'xx'],
      }),
    ).toEqual({ contains: ['aa', 'bb', 'zz'], exact: ['qq'], allow: ['xx', 'yy'] })
  })
})

describe('guest-handle words (data/copy/handleWords.json)', () => {
  const pattern = handlePattern(config)
  const pairs = words.adjectives.flatMap((adjective) =>
    words.nouns.map((noun) => `${adjective}${noun}`),
  )

  it('every AdjectiveNoun pair passes the filter', () => {
    expect(pairs.filter((pair) => !handleAllowed(pair, terms))).toEqual([])
  })

  it('every pair with the longest number fits the format rule', () => {
    const longest = '9'.repeat(config.generated.digits)
    expect(pairs.filter((pair) => !pattern.test(`${pair}${longest}`))).toEqual([])
  })

  it('no word is itself blocked', () => {
    expect([...words.adjectives, ...words.nouns].filter((w) => !handleAllowed(w, terms))).toEqual(
      [],
    )
  })

  it('there are enough pairs for a large city', () => {
    expect(pairs.length * 9 * 10 ** (config.generated.digits - 1)).toBeGreaterThan(300_000)
  })
})
