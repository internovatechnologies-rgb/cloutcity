import { describe, expect, it } from 'vitest'
import { SlangPackSchema } from '@/lib/data/schemas/copy'
import {
  copy,
  copyConfig,
  copyParts,
  createCopy,
  isCopyKey,
  splitTemplate,
  findLiteralSuperlatives,
  interpolate,
  placeholdersOf,
  superlative,
} from './index'
// The whole catalogue, so every namespace is registered for these rendering tests. Namespace
// loading itself is tested in registry.test.ts; the files on disk in files.test.ts.
import { baseCopy, slangPacks } from './all'

const pack = (id: string) => {
  const found = slangPacks[id]
  if (found === undefined) throw new Error(`pack ${id} is not registered`)
  return found
}

describe('slang-pack layer', () => {
  it('swapping the pack changes the rendered text', () => {
    const nyc = createCopy(baseCopy, pack('nyc'))
    const plain = createCopy(baseCopy, pack('plain'))
    expect(nyc('voice.bodega')).toBe("Bacon egg & cheese. It's giving breakfast of champions.")
    expect(plain('voice.bodega')).toBe('Bacon, egg and cheese. Breakfast is sorted.')
    expect(nyc('voice.bodega')).not.toBe(plain('voice.bodega'))
  })

  it('falls back to base for keys a pack does not override', () => {
    expect(createCopy(baseCopy, pack('nyc'))('tabs.map')).toBe('Map')
  })

  it('renders with the configured pack', () => {
    expect(copy('voice.bodega')).toBe(
      createCopy(baseCopy, pack(copyConfig.slangPack))('voice.bodega'),
    )
  })

  it('carries the CLAUDE.md voice samples in the nyc pack', () => {
    const nyc = createCopy(baseCopy, pack('nyc'))
    expect([
      nyc('voice.bodega'),
      nyc('voice.trainDelay'),
      nyc('voice.rentDue'),
      nyc('voice.cloutUp'),
      nyc('voice.landmarkFlex', { landmark: 'Brooklyn Bridge' }),
      nyc('voice.friendPrompt'),
      nyc('voice.clubDoor'),
      nyc('voice.lockedHome'),
      nyc('voice.someoneNearby', { count: '6' }),
      nyc('voice.welcome'),
      nyc('share.footer'),
    ]).toEqual([
      "Bacon egg & cheese. It's giving breakfast of champions.",
      "The train is 'experiencing delays.' You are experiencing main-character suffering.",
      "Landlord said 'rent' and your wallet said 'not today.'",
      "Your name's starting to ring. Brooklyn noticed.",
      'Brooklyn Bridge at golden hour. The algorithm is about to eat.',
      'That W deserves witnesses. Tag a friend in?',
      'Bouncer checked the list, then checked your clout. Not tonight.',
      'Manhattan loft? On bodega money? Work your way here.',
      "You're not the only one out tonight. 6 people on this block.",
      'Welcome to Clout City. Tap in. Blow up.',
      'Tap In. Blow Up. | Clout City: NYC',
    ])
  })
})

describe('interpolate', () => {
  it.each(['{1x} people', '{ a } people', '{a-b}', 'a { b', 'a } b', '{}', '{{a}}'])(
    'throws on the malformed placeholder in %j instead of rendering it',
    (template) => {
      expect(() => interpolate(template, { a: 'x', b: 'y', '1x': 'z' })).toThrow(/malformed/)
    },
  )

  it('the copy schema rejects malformed placeholders and accepts valid ones', () => {
    const pack = (text: string) => ({ id: 'probe', strings: { 'voice.probe': text } })
    for (const bad of ['{1x} people', '{ a } people', 'a { b', 'a } b', '{}']) {
      expect(SlangPackSchema.safeParse(pack(bad)).success, bad).toBe(false)
    }
    expect(SlangPackSchema.safeParse(pack('{count} people on {block2}')).success).toBe(true)
  })

  it('fills every placeholder, repeated ones included', () => {
    expect(interpolate('{a} and {b} and {a}', { a: 'x', b: 'y' })).toBe('x and y and x')
  })

  it('throws on a missing value instead of rendering a half string', () => {
    expect(() => interpolate('{count} people', {})).toThrow(/\{count\}/)
  })

  it('leaves text without placeholders alone', () => {
    expect(interpolate('Rent is due.')).toBe('Rent is due.')
  })
})

describe('superlatives (GR-11)', () => {
  it('no copy string in base or any pack uses a literal superlative', () => {
    const all = [baseCopy.strings, ...Object.values(slangPacks).map((entry) => entry.strings)]
    expect(all.flatMap((strings) => findLiteralSuperlatives(strings))).toEqual([])
  })

  it('the scan catches each banned word in any case, as a whole word', () => {
    const found = findLiteralSuperlatives({
      a: 'The cheapest rent in town',
      b: 'BIGGEST party',
      c: 'Best. Day. Ever.',
      d: 'Most people agree',
      e: 'the fastest train',
      f: 'almost mostly bested', // not whole words
    })
    expect(found.map((entry) => entry.word.toLowerCase())).toEqual([
      'cheapest',
      'biggest',
      'best',
      'most',
      'fastest',
    ])
  })

  it('ignores placeholder names: the value is computed at render time', () => {
    expect(findLiteralSuperlatives({ a: 'The {cheapest} rent in Queens' })).toEqual([])
  })

  const rents = [
    { id: 'queens-room', value: 280 },
    { id: 'brooklyn-1br', value: 520 },
    { id: 'manhattan-loft', value: 1100 },
  ]

  it('returns the word only when the data proves it', () => {
    expect(superlative('cheapest', 'queens-room', rents)).toBe('cheapest')
    expect(superlative('cheapest', 'brooklyn-1br', rents)).toBeNull()
    expect(superlative('biggest', 'manhattan-loft', rents)).toBe('biggest')
    expect(superlative('fastest', 'queens-room', rents)).toBe('fastest')
  })

  it('returns null on a tie, a single entry or an unknown subject', () => {
    const tied = [...rents, { id: 'other-room', value: 280 }]
    expect(superlative('cheapest', 'queens-room', tied)).toBeNull()
    expect(superlative('cheapest', 'queens-room', [{ id: 'queens-room', value: 280 }])).toBeNull()
    expect(superlative('most', 'nowhere', rents)).toBeNull()
  })
})

describe('superlative scanner edge cases (GR-11)', () => {
  it('catches hyphenated, possessive and punctuated forms', () => {
    const found = findLiteralSuperlatives({
      a: 'A best-in-class fit',
      b: 'The most-viewed clip',
      c: "Queens' cheapest's deal",
      d: '(fastest) route',
      e: 'Biggest!',
    })
    expect(found.map((entry) => entry.key)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('catches a literal superlative glued to a placeholder', () => {
    expect(findLiteralSuperlatives({ a: '{place}best spot' })).toEqual([{ key: 'a', word: 'best' }])
    expect(findLiteralSuperlatives({ a: 'the most{suffix}' })).toEqual([{ key: 'a', word: 'most' }])
  })

  it('reports every occurrence with its key', () => {
    expect(findLiteralSuperlatives({ a: 'best and BEST', b: 'fine' })).toEqual([
      { key: 'a', word: 'best' },
      { key: 'a', word: 'BEST' },
    ])
  })

  it('does not flag words that merely contain a banned word', () => {
    expect(
      findLiteralSuperlatives({ a: 'Bestie, mostly almost utmost, breakfastest? no: fasted' }),
    ).toEqual([])
  })
})

describe('superlative() only claims what the data proves (GR-11)', () => {
  const rents = [
    { id: 'queens-room', value: 280 },
    { id: 'brooklyn-1br', value: 520 },
  ]

  it('returns null when a value is NaN', () => {
    expect(superlative('cheapest', 'queens-room', [...rents, { id: 'x', value: NaN }])).toBeNull()
    expect(superlative('cheapest', 'x', [...rents, { id: 'x', value: NaN }])).toBeNull()
  })

  it('returns null when the only competitor is the subject itself (duplicate ids)', () => {
    const selfOnly = [
      { id: 'queens-room', value: 280 },
      { id: 'queens-room', value: 280 },
    ]
    expect(superlative('cheapest', 'queens-room', selfOnly)).toBeNull()
  })

  it('returns null when the subject id appears twice with different values', () => {
    const conflicting = [
      { id: 'queens-room', value: 280 },
      { id: 'brooklyn-1br', value: 520 },
      { id: 'queens-room', value: 900 },
    ]
    expect(superlative('cheapest', 'queens-room', conflicting)).toBeNull()
  })

  it('uses the localized word from base copy, not the kind name', () => {
    const custom = {
      ...baseCopy,
      superlatives: { ...baseCopy.superlatives, cheapest: 'lowest-priced' },
    }
    expect(superlative('cheapest', 'queens-room', rents, custom)).toBe('lowest-priced')
  })
})

describe('copy() rendering contract', () => {
  it('throws when a real key is rendered without its placeholder value', () => {
    expect(() => copy('voice.someoneNearby')).toThrow(/\{count\}/)
    expect(() => copy('voice.landmarkFlex', { other: 'x' })).toThrow(/\{landmark\}/)
  })

  it('throws on an unknown key instead of rendering nothing', () => {
    const render = createCopy(baseCopy, pack('plain'))
    expect(() => render('no.such.key' as Parameters<typeof render>[0])).toThrow(/no\.such\.key/)
  })

  it('does not re-expand placeholder syntax or $-patterns inside a value', () => {
    expect(interpolate('{a}', { a: '{b} $& $1' })).toBe('{b} $& $1')
  })

  it('a pack override changes only that key', () => {
    const swapped = createCopy(baseCopy, { id: 'probe', strings: { 'tabs.map': 'City' } })
    expect(swapped('tabs.map')).toBe('City')
    expect(swapped('tabs.shop')).toBe(createCopy(baseCopy, pack('plain'))('tabs.shop'))
  })

  it('no copy string has a brace outside a valid {placeholder}, so none renders raw braces', () => {
    const all = [
      ['base', baseCopy.strings] as const,
      ...Object.entries(slangPacks).map(([id, entry]) => [id, entry.strings] as const),
    ]
    const stray = all.flatMap(([source, strings]) =>
      Object.entries(strings)
        .filter(([, text]) => /[{}]/.test(text.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, '')))
        .map(([key]) => `${source}:${key}`),
    )
    expect(stray).toEqual([])
  })

  it('treats malformed placeholders as non-placeholders (documents current behaviour)', () => {
    // {1x} and { a } are not valid names, so they are neither required nor filled.
    expect(placeholdersOf('{1x} { a } {ok}')).toEqual(['ok'])
  })
})

describe('copyParts and splitTemplate', () => {
  it('splits a template into text and slots in order', () => {
    expect(splitTemplate('I agree to the {terms} and the {privacy}.')).toEqual([
      { kind: 'text', text: 'I agree to the ' },
      { kind: 'slot', name: 'terms' },
      { kind: 'text', text: ' and the ' },
      { kind: 'slot', name: 'privacy' },
      { kind: 'text', text: '.' },
    ])
  })

  it('handles leading, trailing, adjacent and absent slots', () => {
    expect(splitTemplate('{a}{b}')).toEqual([
      { kind: 'slot', name: 'a' },
      { kind: 'slot', name: 'b' },
    ])
    expect(splitTemplate('plain')).toEqual([{ kind: 'text', text: 'plain' }])
  })

  it('throws on a malformed placeholder', () => {
    expect(() => splitTemplate('a { b')).toThrow(/malformed/)
  })

  it('splits the active-pack consent label around the Terms and Privacy slots', () => {
    const slots = copyParts('welcome.consent.label').filter((part) => part.kind === 'slot')
    expect(slots.map((part) => part.name)).toEqual(['terms', 'privacy'])
  })

  it('isCopyKey knows base keys only', () => {
    expect(isCopyKey('welcome.title')).toBe(true)
    expect(isCopyKey('welcome.nope')).toBe(false)
    expect(isCopyKey('toString')).toBe(false)
  })
})

describe('welcome card copy (S05a)', () => {
  const nyc = createCopy(baseCopy, pack('nyc'))
  const plain = createCopy(baseCopy, pack('plain'))

  it('carries the in-voice under-age screen in the nyc pack', () => {
    expect(nyc('ageGate.title')).toBe("Come back when you're 18.")
    expect(nyc('ageGate.body')).toBe(
      'Clout City is for grown folks only. The city will still be here.',
    )
    expect(plain('ageGate.title')).toBe('You need to be 18 or older to play.')
  })

  it('gives no hint of the age threshold on the card before submit, in any pack', () => {
    const cardKeys = Object.keys(baseCopy.strings).filter(
      (key) => key.startsWith('welcome.') && !key.endsWith('.error'),
    )
    for (const render of [nyc, plain]) {
      for (const key of cardKeys) {
        if (!isCopyKey(key)) throw new Error(key)
        const text =
          key === 'welcome.consent.label' ? render(key, { terms: 'T', privacy: 'P' }) : render(key)
        expect(text, key).not.toMatch(/18|eighteen|adult|age\b|old enough/i)
      }
    }
  })
})
