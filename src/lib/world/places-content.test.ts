/**
 * Content checks for S07 places: the required landmarks are present and safe (categories,
 * name modes, generic labels for brands, look-only memorials), every playable borough has its
 * eight invented venues with original names, place copy never asserts an uncomputed
 * superlative, and every place agrees with the S04 geo layers. A geo mismatch prints the
 * value the data should hold.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { balance } from '@/lib/data/config'
import { boroughs, landmarks, venues } from '@/lib/data/content'
import { land, parks, subway, zoneShapes } from '@/lib/data/geo'
import { HoursSchema, LandmarksFileSchema, VenuesFileSchema } from '@/lib/data/schemas/content'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { placeAllows, type PlaceHook } from '@/engine/places'
import { areaAt, distanceToArea, prepareAreas } from '@/lib/geo/lookup'
import { distanceM, project, unproject } from '@/lib/geo/projection'
import { PLACEHOLDER } from '@/lib/placeholders'

const DATA = join(import.meta.dirname, '../../../data')

/** Every landmark the S07 acceptance criteria name, plus the two expanding-soon teasers. */
const REQUIRED_LANDMARKS = [
  'brooklyn-bridge',
  'manhattan-bridge',
  'queensboro-bridge',
  'wedge-building',
  'deco-spire',
  'statue-of-liberty',
  'washington-square-arch',
  'central-park',
  'high-line',
  'prospect-park',
  'flushing-meadows',
  'astoria-park',
  'queens-ballpark',
  'brooklyn-arena',
  'city-hall',
  'brooklyn-borough-hall',
  'queens-borough-hall',
  'midtown-terminal',
  'penn-station',
  'jamaica-station',
  'times-square',
  'dumbo',
  'coney-island-boardwalk',
  'flushing-main-street',
  'september-11-memorial',
]
const TEASER_LANDMARKS = ['bronx-ballpark', 'staten-island-ferry']

/**
 * The real-world name of every landmark. A real name that contains a branded term must use a
 * generic label (nameMode `generic`).
 */
const LANDMARK_REAL_NAMES: Readonly<Record<string, string>> = {
  'brooklyn-bridge': 'Brooklyn Bridge',
  'manhattan-bridge': 'Manhattan Bridge',
  'queensboro-bridge': 'Ed Koch Queensboro Bridge',
  'wedge-building': 'Flatiron Building',
  'deco-spire': 'Chrysler Building',
  'statue-of-liberty': 'Statue of Liberty',
  'washington-square-arch': 'Washington Square Arch',
  'central-park': 'Central Park',
  'high-line': 'High Line',
  'prospect-park': 'Prospect Park',
  'flushing-meadows': 'Flushing Meadows Corona Park',
  'astoria-park': 'Astoria Park',
  'queens-ballpark': 'Citi Field',
  'brooklyn-arena': 'Barclays Center',
  'city-hall': 'New York City Hall',
  'brooklyn-borough-hall': 'Brooklyn Borough Hall',
  'queens-borough-hall': 'Queens Borough Hall',
  'midtown-terminal': 'Grand Central Terminal',
  'penn-station': 'Pennsylvania Station',
  'jamaica-station': 'Jamaica Station',
  'times-square': 'Times Square',
  dumbo: 'DUMBO',
  'coney-island-boardwalk': 'Riegelmann Boardwalk',
  'flushing-main-street': 'Main Street, Flushing',
  'september-11-memorial': 'National September 11 Memorial',
  'bronx-ballpark': 'Yankee Stadium',
  'staten-island-ferry': 'Staten Island Ferry',
}

/** Corporate, sponsor or licensed names that must never appear in place copy or ids. */
const BRANDED_TERMS = [
  'Empire State',
  'Rockefeller',
  'Top of the Rock',
  'Madison Square Garden',
  'Barclays',
  'Citi Field',
  'Citi',
  'Yankee Stadium',
  'Yankees',
  'Mets',
  'Nets',
  'Knicks',
  'Chrysler',
  'Flatiron Building',
  'Grand Central Terminal',
  'One World Trade',
  'Freedom Tower',
  'Hudson Yards',
  'Vessel',
  'Summit One Vanderbilt',
  'Luna Park',
  'Wonder Wheel',
  'Cyclone',
  "Nathan's",
  "Macy's",
  'MTA',
  'MetroCard',
  'OMNY',
]

/** Real NYC businesses (and near-misses rejected while naming) no venue may be named after. */
const REAL_NYC_BUSINESSES = [
  "Katz's",
  "Joe's Pizza",
  'Peter Luger',
  'Russ & Daughters',
  "Juliana's",
  'Arepa Lady',
  'Ninth Street Espresso',
  'Third Rail Coffee',
  'Blue Bottle',
  'Stumptown',
  'Devoción',
  'Starbucks',
  "Dunkin'",
  'Duane Reade',
  'Buffalo Exchange',
  "Beacon's Closet",
  'L Train Vintage',
  'Housing Works',
  'Equinox',
  'Planet Fitness',
  'Blink',
  'Crunch',
  'Harbor Fitness',
  'House of Yes',
  'Elsewhere',
  'Nowadays',
  'Signal',
  'Good Room',
  'Le Bain',
  'Marquee',
  'Velvet Brooklyn',
  'Halo Deli',
  'Moon Deli',
  'Three Owls Market',
  'Steamworks Coffee',
  'Prince Street Pizza',
  'Veselka',
  'Shake Shack',
  'Levain',
  'Xi’an Famous Foods',
  'Superiority Burger',
  'Win Son',
  'Brooklyn Athletic Club',
  'Analog BKNY',
  'Joe Coffee',
  'Supreme',
  'Kith',
  'Flight Club',
  'Comme des Garçons',
  'Dover Street Market',
  'Aimé Leon Dore',
  'Stüssy',
  'Round Two',
  'Grey Dog',
  'Gray’s Papaya',
  'Lucali',
  "L'Industrie",
  'Los Tacos No. 1',
  'Sey Coffee',
  'Abraço',
  'La Colombe',
  'Variety Coffee',
  'Café Grumpy',
  'Bodega Negra',
  'Output',
  'Basement',
  'Brooklyn Mirage',
  'Avant Gardner',
  'Paragon',
  'Public Records',
  '10 Below',
  'Retro Fitness',
  'Blink Fitness',
  'Chelsea Piers',
]

/** GR-11 words a place or borough string may only carry through a computed {rank}. */
const SUPERLATIVES =
  /\b(?:cheapest|biggest|best|most|fastest|greatest|tallest|oldest|largest|finest|hottest|coolest|freshest|number one|top|the only)\b|#1\b/i

const PLACE_COPY = /^(?:landmarks|venues|boroughs|places)\./

const allCopy = [
  { pack: 'base', strings: baseCopy.strings },
  ...Object.values(slangPacks).map((pack) => ({ pack: pack.id, strings: pack.strings })),
]
const placeStrings = allCopy.flatMap(({ pack, strings }) =>
  Object.entries(strings)
    .filter(([key]) => PLACE_COPY.test(key))
    .map(([key, text]) => ({ pack, key, text })),
)

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const wholeWord = (term: string) =>
  new RegExp(
    `(?:^|[^a-z0-9])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`,
  )

const nameOf = (key: string) => baseCopy.strings[key] ?? ''

describe('landmarks', () => {
  it('lists every required landmark and both teasers', () => {
    const ids = landmarks.map((entry) => entry.id)
    expect(REQUIRED_LANDMARKS.filter((id) => !ids.includes(id))).toEqual([])
    expect(TEASER_LANDMARKS.filter((id) => !ids.includes(id))).toEqual([])
  })

  it('every landmark has a category and nameMode and is not legally reviewed yet', () => {
    for (const entry of landmarks) {
      expect(entry.category, entry.id).toBeDefined()
      expect(['real', 'generic'], entry.id).toContain(entry.nameMode)
      expect(entry.legalReviewed, entry.id).toBe(false)
    }
  })

  it('the 9/11 Memorial is in the memorial category and look-only', () => {
    const memorial = landmarks.find((entry) => entry.id === 'september-11-memorial')
    expect(memorial).toMatchObject({ category: 'memorial', lookOnly: true })
  })

  it('records the real name of every landmark (fixture covers the data)', () => {
    expect(landmarks.map((entry) => entry.id).sort()).toEqual(
      Object.keys(LANDMARK_REAL_NAMES).sort(),
    )
  })

  it('a landmark whose real name is branded uses a generic label', () => {
    const branded = landmarks.filter((entry) => {
      const real = normalize(LANDMARK_REAL_NAMES[entry.id] ?? '')
      return BRANDED_TERMS.some((term) => wholeWord(normalize(term)).test(real))
    })
    expect(branded.map((entry) => entry.id).sort()).toEqual(
      [
        'bronx-ballpark',
        'brooklyn-arena',
        'deco-spire',
        'midtown-terminal',
        'queens-ballpark',
        'wedge-building',
      ].sort(),
    )
    expect(branded.filter((entry) => entry.nameMode !== 'generic')).toEqual([])
  })

  it('a generic label has no leading article', () => {
    const generic = landmarks.filter((entry) => entry.nameMode === 'generic')
    expect(
      generic.map((entry) => nameOf(entry.nameKey)).filter((n) => /^(?:the|a|an)\s/i.test(n)),
    ).toEqual([])
  })
})

describe('branded names never reach players', () => {
  it('no place, borough or places.* string in base or any pack names a branded term', () => {
    const hits = placeStrings.flatMap(({ pack, key, text }) =>
      BRANDED_TERMS.filter((term) => wholeWord(normalize(term)).test(normalize(text))).map(
        (term) => `${pack}: ${key} names "${term}"`,
      ),
    )
    expect(hits).toEqual([])
  })

  it('no place id carries a branded term', () => {
    const ids = [...venues, ...landmarks].map((entry) => entry.id.replace(/-/g, ' '))
    const hits = ids.filter((id) =>
      BRANDED_TERMS.some((term) => wholeWord(normalize(term)).test(id)),
    )
    expect(hits).toEqual([])
  })

  it('the scan matches whole words in any case', () => {
    expect(wholeWord(normalize('Mets')).test(normalize('the METS game'))).toBe(true)
    expect(wholeWord(normalize('Mets')).test(normalize('Helmets for sale'))).toBe(false)
    expect(wholeWord(normalize('Citi')).test(normalize('Citi Field'))).toBe(true)
  })
})

const PLAYABLE = ['queens', 'brooklyn', 'manhattan'] as const
const SLOTS: readonly (readonly string[])[] = [
  ['bodega'],
  ['food-spot'],
  ['subway-station'],
  ['park', 'gym'],
  ['coffee-shop'],
  ['thrift', 'boutique'],
  ['club'],
  ['job-site'],
]

describe('venues', () => {
  it.each(PLAYABLE)('%s has exactly 8 venues, one per required kind', (borough) => {
    const own = venues.filter((entry) => entry.borough === borough)
    expect(own).toHaveLength(8)
    for (const slot of SLOTS) {
      expect(
        own.filter((entry) => slot.includes(entry.type)),
        slot.join('|'),
      ).toHaveLength(1)
    }
  })

  it('the Bronx and Staten Island have no venues yet', () => {
    expect(
      venues.filter((entry) => !(PLAYABLE as readonly string[]).includes(entry.borough)),
    ).toEqual([])
  })

  it('venue and landmark ids share one id space with no repeats', () => {
    const ids = [...venues, ...landmarks].map((entry) => entry.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })

  it('no venue is named after a real NYC business', () => {
    const hits = venues.flatMap((venue) => {
      const name = normalize(nameOf(venue.nameKey))
      return REAL_NYC_BUSINESSES.filter((business) => {
        const real = normalize(business)
        return name === real || wholeWord(real).test(name)
      }).map((business) => `${venue.id} matches "${business}"`)
    })
    expect(hits).toEqual([])
  })

  it('data/venues/SOURCES.md records the name search for every venue', () => {
    const sources = readFileSync(join(DATA, 'venues/SOURCES.md'), 'utf8')
    expect(venues.filter((venue) => !sources.includes(`\`${venue.id}\``)).map((v) => v.id)).toEqual(
      [],
    )
  })

  it('data/landmarks/SOURCES.md records the source of every landmark', () => {
    const sources = readFileSync(join(DATA, 'landmarks/SOURCES.md'), 'utf8')
    expect(
      landmarks.filter((entry) => !sources.includes(`\`${entry.id}\``)).map((l) => l.id),
    ).toEqual([])
  })

  it('the Queens bodega is open around the clock (the first purchase always works)', () => {
    const bodega = venues.find((entry) => entry.borough === 'queens' && entry.type === 'bodega')
    expect(bodega?.hours).toBe('24h')
  })
})

describe('memorials', () => {
  const memorial = landmarks.find((entry) => entry.category === 'memorial')
  if (memorial === undefined) throw new Error('no memorial in data')

  it.each([
    ['interactions', ['visit']],
    ['flexTier', 1],
    ['flexMultiplier', 2],
    ['clout', 5],
    ['cloutBonus', 5],
    ['emotes', ['wave']],
    ['eventIds', ['placeholder-event']],
  ])('the schema rejects a memorial with %s', (field, value) => {
    expect(
      LandmarksFileSchema.safeParse({ landmarks: [{ ...memorial, [field]: value }] }).success,
    ).toBe(false)
  })

  it('the schema rejects a memorial that is not look-only', () => {
    expect(
      LandmarksFileSchema.safeParse({ landmarks: [{ ...memorial, lookOnly: false }] }).success,
    ).toBe(false)
  })

  it('the schema rejects a non-memorial landmark without interactions', () => {
    const park = landmarks.find((entry) => entry.category === 'park')
    if (park === undefined || !('interactions' in park)) throw new Error('no park in data')
    const withoutInteractions: Record<string, unknown> = { ...park }
    delete withoutInteractions.interactions
    expect(LandmarksFileSchema.safeParse({ landmarks: [withoutInteractions] }).success).toBe(false)
    expect(
      LandmarksFileSchema.safeParse({ landmarks: [{ ...park, interactions: [] }] }).success,
    ).toBe(false)
    expect(
      LandmarksFileSchema.safeParse({ landmarks: [{ ...park, interactions: ['visit', 'visit'] }] })
        .success,
    ).toBe(false)
  })

  it.each(['visit', 'flex', 'emote', 'events', 'crime'] satisfies PlaceHook[])(
    'no memorial allows %s',
    (hook) => {
      expect(
        landmarks.filter((entry) => entry.category === 'memorial' && placeAllows(entry, hook)),
      ).toEqual([])
    },
  )

  const filesUnder = (dir: string) =>
    readdirSync(join(DATA, dir), { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(DATA, join(entry.parentPath, entry.name)))

  it('no event or config file names a memorial or the memorial category', () => {
    const memorialIds = landmarks.filter((entry) => entry.category === 'memorial').map((e) => e.id)
    const hits = [...filesUnder('events'), ...filesUnder('config')].flatMap((file) => {
      const text = readFileSync(join(DATA, file), 'utf8')
      return [...memorialIds, 'memorial']
        .filter((term) => text.includes(term))
        .map((t) => `${file}: ${t}`)
    })
    expect(hits).toEqual([])
  })

  it('no slang pack overrides memorial copy', () => {
    const keys = landmarks
      .filter((entry) => entry.category === 'memorial')
      .flatMap((entry) => [entry.nameKey, entry.infoKey])
    const overrides = Object.values(slangPacks).flatMap((pack) =>
      keys.filter((key) => key in pack.strings).map((key) => `${pack.id}: ${key}`),
    )
    expect(overrides).toEqual([])
  })

  it('memorial copy is plain: no exclamation marks', () => {
    const keys = landmarks
      .filter((entry) => entry.category === 'memorial')
      .flatMap((entry) => [entry.nameKey, entry.infoKey])
    expect(keys.filter((key) => nameOf(key).includes('!'))).toEqual([])
  })

  it('no crime-tagged event targets a government building or the government category', () => {
    const governmentIds = landmarks
      .filter((entry) => entry.category === 'government')
      .map((e) => e.id)
    const file = JSON.parse(readFileSync(join(DATA, 'events/events.json'), 'utf8')) as {
      events: unknown[]
    }
    const hits = file.events
      .map((event) => JSON.stringify(event))
      .filter((text) => /crime/i.test(text))
      .filter((text) => [...governmentIds, 'government'].some((term) => text.includes(`"${term}"`)))
    expect(hits).toEqual([])
  })
})

describe('superlatives in place copy (GR-11)', () => {
  it('no place, borough or places.* string asserts a rank as literal text', () => {
    const hits = placeStrings
      .filter(({ text }) => SUPERLATIVES.test(text.replace(PLACEHOLDER, ' ')))
      .map(({ pack, key }) => `${pack}: ${key}`)
    expect(hits).toEqual([])
  })

  it('the scan catches the extended word list and ignores placeholders', () => {
    for (const text of [
      'The tallest tower',
      'Oldest bar',
      'the only spot',
      '#1 in Queens',
      'Top floor',
    ]) {
      expect(SUPERLATIVES.test(text), text).toBe(true)
    }
    expect(SUPERLATIVES.test('The {rank} deli on the block'.replace(PLACEHOLDER, ' '))).toBe(false)
    expect(SUPERLATIVES.test('A rooftop, mostly')).toBe(false)
  })
})

describe('boroughs file', () => {
  it('names all five boroughs, the Bronx as "The Bronx"', () => {
    expect(boroughs.map((entry) => entry.id).sort()).toEqual([
      'bronx',
      'brooklyn',
      'manhattan',
      'queens',
      'staten-island',
    ])
    expect(nameOf(boroughs.find((entry) => entry.id === 'bronx')?.nameKey ?? '')).toBe('The Bronx')
  })

  it('Queens is open; clout boroughs have why-locked copy; expanding-soon ones a teaser', () => {
    expect(balance.boroughs.queens).toEqual({ access: 'open' })
    for (const entry of boroughs) {
      const rule = balance.boroughs[entry.id]
      if (rule.access === 'clout') {
        expect(entry.lockedKey, entry.id).toBeDefined()
        expect(
          balance.clout.levels.map((level) => level.id),
          entry.id,
        ).toContain(rule.level)
      }
      if (rule.access === 'expanding-soon') {
        expect(entry.teaserKey, entry.id).toBeDefined()
        expect(entry.teaserLandmarkIds.length, entry.id).toBeGreaterThan(0)
      }
    }
  })

  it('teaser landmarks exist and sit in their borough', () => {
    for (const entry of boroughs) {
      for (const id of entry.teaserLandmarkIds) {
        expect(landmarks.find((landmark) => landmark.id === id)?.borough, id).toBe(entry.id)
      }
    }
  })

  it('every borough copy key exists in base', () => {
    const keys = boroughs.flatMap((entry) =>
      [entry.nameKey, entry.lockedKey, entry.teaserKey].filter((key) => key !== undefined),
    )
    expect(keys.filter((key) => !(key in baseCopy.strings))).toEqual([])
  })

  it('why-locked copy takes {level} and {current} in every pack', () => {
    for (const { pack, strings } of allCopy) {
      for (const key of ['boroughs.brooklyn.locked', 'boroughs.manhattan.locked']) {
        const text = strings[key]
        if (text === undefined) continue
        expect(text, `${pack}: ${key}`).toContain('{level}')
        expect(text, `${pack}: ${key}`).toContain('{current}')
      }
    }
  })
})

describe('places agree with the S04 geo layers', () => {
  const boroughAreas = prepareAreas(land.boroughs)
  const zoneAreas = prepareAreas(zoneShapes.zones)
  const parkAreas = prepareAreas(parks.parks)
  const zoneBorough = new Map(
    // zones.derived.json carries each zone's borough; the shapes file shares its ids.
    (
      JSON.parse(readFileSync(join(DATA, 'zones/zones.derived.json'), 'utf8')) as {
        zones: { id: string; borough: string }[]
      }
    ).zones.map((zone) => [zone.id, zone.borough]),
  )
  const places = [...venues, ...landmarks]
  const routePoint = (place: (typeof places)[number]) =>
    project('approach' in place && place.approach !== undefined ? place.approach : place.location)

  it.each(places.map((place) => [place.id, place] as const))(
    '%s: borough and zone match its route point',
    (_id, place) => {
      const point = routePoint(place)
      expect(areaAt(point, boroughAreas), 'borough').toBe(place.borough)
      expect(areaAt(point, zoneAreas), 'zoneId').toBe(place.zoneId)
      expect(zoneBorough.get(place.zoneId), 'zone borough').toBe(place.borough)
    },
  )

  it.each(landmarks.map((entry) => [entry.id, entry] as const))(
    '%s: its location is reachable or it has an approach',
    (_id, entry) => {
      const point = project(entry.location)
      const at = areaAt(point, boroughAreas)
      if (at === undefined) {
        expect(entry.approach, 'approach is required off land').toBeDefined()
      } else {
        expect([entry.borough, ...(entry.spans ?? [])]).toContain(at)
      }
      if (entry.category === 'bridge') {
        expect(entry.spans, 'a bridge lists the boroughs it spans').toBeDefined()
        for (const borough of entry.spans ?? []) {
          const area = boroughAreas.find((candidate) => candidate.id === borough)
          if (area === undefined) throw new Error(`no land for ${borough}`)
          expect(distanceToArea(point, area), `distance to ${borough}`).toBeLessThanOrEqual(600)
        }
      }
    },
  )

  it('no non-park venue sits inside a park', () => {
    const inPark = venues
      .filter((venue) => venue.type !== 'park')
      .filter((venue) => areaAt(project(venue.location), parkAreas) !== undefined)
    expect(inPark.map((venue) => venue.id)).toEqual([])
  })

  it('venues are at least 50 m apart', () => {
    const close: string[] = []
    venues.forEach((a, i) => {
      venues.slice(i + 1).forEach((b) => {
        const gap = distanceM(project(a.location), project(b.location))
        if (gap < 50) close.push(`${a.id} and ${b.id}: ${Math.round(gap)} m`)
      })
    })
    expect(close).toEqual([])
  })

  it.each(
    venues.flatMap((venue) =>
      venue.type === 'subway-station' ? [[venue.id, venue] as const] : [],
    ),
  )('%s points at its S04 station, within 25 m', (_id, venue) => {
    const station = subway.stations.find((entry) => entry.id === venue.stationId)
    expect(station, `station ${venue.stationId}`).toBeDefined()
    if (station === undefined) return
    const at = unproject(station)
    expect(distanceM(project(venue.location), project(at))).toBeLessThanOrEqual(25)
    expect(station.borough).toBe(venue.borough)
    expect(station.zoneId).toBe(venue.zoneId)
  })
})

describe('venue and hours schema unions', () => {
  const station = venues.find((venue) => venue.type === 'subway-station')
  const business = venues.find((venue) => venue.type === 'coffee-shop')
  if (station === undefined || business === undefined) throw new Error('no station or coffee shop')
  const parses = (venue: unknown) => VenuesFileSchema.safeParse({ venues: [venue] }).success

  it('the sampled data entries parse as they are', () => {
    expect(parses(station)).toBe(true)
    expect(parses(business)).toBe(true)
  })

  it('a station venue with jobIds is rejected', () => {
    expect(parses({ ...station, jobIds: ['barista'] })).toBe(false)
  })

  it('a business venue with a stationId is rejected', () => {
    expect(parses({ ...business, stationId: 'r04' })).toBe(false)
  })

  it('a station venue without a stationId is rejected', () => {
    const withoutStation: Record<string, unknown> = { ...station }
    delete withoutStation.stationId
    expect(parses(withoutStation)).toBe(false)
  })

  it('a business venue with empty or unknown jobIds is rejected', () => {
    expect(parses({ ...business, jobIds: [] })).toBe(false)
    expect(parses({ ...business, jobIds: ['astronaut'] })).toBe(false)
  })

  it('venues carry no price fields', () => {
    expect(parses({ ...business, price: 5 })).toBe(false)
    expect(parses({ ...station, price: 3 })).toBe(false)
  })

  it.each([
    ['24h', true],
    [{ open: '22:00', close: '04:00' }, true],
    [{ open: '00:00', close: '23:59' }, true],
    [{ open: '18:00', close: '00:00' }, true],
    ['24h ', false],
    ['24H', false],
    [{ open: '09:00', close: '09:00' }, false],
    [{ open: '00:00', close: '00:00' }, false],
    [{ open: '24:00', close: '06:00' }, false],
    [{ open: '7:00', close: '19:00' }, false],
    [{ open: '07:60', close: '19:00' }, false],
    [{ open: '07:00 ', close: '19:00' }, false],
    [{ open: '07:00' }, false],
    [{ open: '07:00', close: '19:00', days: 'mon' }, false],
  ])('hours %j parse: %s', (hours, ok) => {
    expect(HoursSchema.safeParse(hours).success).toBe(ok)
  })
})

describe('landmark schema strictness', () => {
  const memorial = landmarks.find((entry) => entry.category === 'memorial')
  const park = landmarks.find((entry) => entry.category === 'park')
  if (memorial === undefined || park === undefined) throw new Error('no memorial or park')
  const parses = (entry: unknown) => LandmarksFileSchema.safeParse({ landmarks: [entry] }).success

  it.each(['emote', 'events', 'flex', 'notes', 'hooks', 'crime', 'zzUnknownFutureKey'])(
    'a memorial with any extra key (%s) is rejected',
    (key) => {
      expect(parses({ ...memorial, [key]: true })).toBe(false)
    },
  )

  it('a memorial missing lookOnly is rejected', () => {
    const withoutLookOnly: Record<string, unknown> = { ...memorial }
    delete withoutLookOnly.lookOnly
    expect(parses(withoutLookOnly)).toBe(false)
  })

  it('a non-memorial cannot pose as look-only or carry unknown interactions', () => {
    expect(parses({ ...park, lookOnly: true })).toBe(false)
    expect(parses({ ...park, interactions: ['visit', 'crime'] })).toBe(false)
  })

  it('a landmark with fewer than two spans is rejected', () => {
    expect(parses({ ...park, spans: ['queens'] })).toBe(false)
  })
})

describe('place names in every pack', () => {
  it('no place name or info string is empty or holds a raw placeholder brace', () => {
    const keys = [...venues, ...landmarks].flatMap((entry) => [
      entry.nameKey,
      'infoKey' in entry ? entry.infoKey : entry.blurbKey,
    ])
    const bad = allCopy.flatMap(({ pack, strings }) =>
      keys
        .filter((key) => pack === 'base' || key in strings)
        .filter((key) => {
          const text = strings[key]
          return text === undefined || text.trim() === '' || /[{}]/.test(text)
        })
        .map((key) => `${pack}: ${key}`),
    )
    expect(bad).toEqual([])
  })
})
