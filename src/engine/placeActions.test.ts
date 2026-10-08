import { describe, expect, it } from 'vitest'
import type { Landmark, Venue } from '@/lib/data/schemas/content'
import { totalClout } from './clout'
import { engineConfig, type EngineConfig } from './config'
import { initialSnapshot, type GameSnapshot } from './game'
import {
  clubNightKey,
  flexMultiplier,
  performPlaceAction as performPlaceActionAnywhere,
  placeActions as placeActionsAnywhere,
  placeHoursNow,
  type PlaceAction,
  type PlaceView,
} from './placeActions'
import {
  atPlace,
  performPlaceActionHere as performPlaceAction,
  placeActionsHere as placeActions,
  withClout,
} from './test-support'

/** Fixed numbers so these tests do not move when balance.json is tuned (S12). */
const config: EngineConfig = {
  ...engineConfig,
  startCash: 150,
  stats: {
    ...engineConfig.stats,
    max: 100,
    start: { energy: 100, hunger: 80, mood: 70 },
    decayPerGameHour: { energy: 3, hunger: 5, mood: 2 },
  },
  actions: {
    maxDurationMin: 1440,
    catalog: {
      'bodega-breakfast': {
        durationMin: 20,
        cashCost: 6,
        energyCost: 0,
        statEffects: { hunger: 40, mood: 5 },
      },
      'walk-in-the-park': {
        durationMin: 60,
        cashCost: 0,
        energyCost: 10,
        statEffects: { mood: 15 },
      },
    },
  },
  jobs: {
    shiftHours: 4,
    hourlyWage: { barista: 14, retail: 16, delivery: 18, 'junior-dev': 35 },
    energyCostPerShift: { barista: 15, retail: 15, delivery: 25, 'junior-dev': 15 },
    requiredCloutLevel: { 'junior-dev': 'local' },
  },
  clout: {
    ...engineConfig.clout,
    levels: [
      { id: 'nobody', minClout: 0 },
      { id: 'local', minClout: 100 },
      { id: 'scene-regular', minClout: 300 },
      { id: 'known', minClout: 800 },
    ],
  },
  boroughs: {
    queens: { access: 'open' },
    brooklyn: { access: 'clout', level: 'local' },
    manhattan: { access: 'clout', level: 'scene-regular' },
    bronx: { access: 'expanding-soon' },
    'staten-island': { access: 'expanding-soon' },
  },
  place: {
    venueActions: {
      bodega: ['bodega-breakfast'],
      'food-spot': ['street-meal'],
      'coffee-shop': ['coffee'],
      gym: ['workout'],
      park: ['walk-in-the-park'],
      'subway-station': [],
      thrift: [],
      boutique: [],
      club: [],
      'job-site': [],
    },
    homeActions: ['sleep', 'nap', 'home-meal'],
    actions: {
      coffee: { durationMin: 15, cashCost: 5, energyCost: 0, statEffects: { energy: 10 } },
      'street-meal': { durationMin: 30, cashCost: 9, energyCost: 0, statEffects: { hunger: 45 } },
      workout: { durationMin: 60, cashCost: 8, energyCost: 20, statEffects: { mood: 12 } },
    },
    clubs: {
      'probe-club': {
        coverCharge: 15,
        minCloutLevel: 'local',
        refusalKey: 'club.door.refused',
        durationMin: 120,
        energyCost: 15,
        moodGain: 10,
        cloutGain: 10,
      },
    },
    visit: { durationMin: 60, energyCost: 5, moodGain: 10 },
    flexMultiplier: { default: 1, byLandmark: { 'probe-bridge': 2 } },
  },
}

const DAY = 24 * 60
const at = (clock: string, day = 0) => {
  const [h = 0, m = 0] = clock.split(':').map(Number)
  return day * DAY + h * 60 + m
}

function snapshotWith(
  overrides: {
    minute?: number
    cash?: number
    clout?: number
    stats?: Partial<GameSnapshot['player']['stats']>
  } = {},
): GameSnapshot {
  const base = initialSnapshot(config)
  const snapshot = {
    clock: { minute: overrides.minute ?? at('12:00'), remainderMs: 0 },
    player: {
      ...base.player,
      cash: overrides.cash ?? base.player.cash,
      stats: { ...base.player.stats, ...overrides.stats },
    },
  }
  return withClout(snapshot, overrides.clout ?? 0, config)
}

const placeBase = {
  nameKey: 'venues.probe.name',
  blurbKey: 'venues.probe.blurb',
  borough: 'queens',
  zoneId: 'qn01',
  location: { lat: 40.76, lng: -73.92 },
} as const

function venue(type: Venue['type'], extra: Partial<Venue> = {}): Venue {
  const id = type === 'club' ? 'probe-club' : `probe-${type}`
  if (type === 'subway-station') {
    return { ...placeBase, id, type, hours: '24h', stationId: 'probe', ...extra } as Venue
  }
  return { ...placeBase, id, type, hours: { open: '06:00', close: '19:00' }, ...extra } as Venue
}

const club = venue('club', { hours: { open: '22:00', close: '04:00' } })

const landmarkBase = {
  nameKey: 'landmarks.probe.name',
  infoKey: 'landmarks.probe.info',
  nameMode: 'real',
  legalReviewed: false,
  borough: 'queens',
  zoneId: 'qn01',
  location: { lat: 40.75, lng: -73.84 },
} as const

const bridge: Landmark = {
  ...landmarkBase,
  id: 'probe-bridge',
  category: 'bridge',
  interactions: ['visit', 'flex', 'emote'],
}
const park: Landmark = {
  ...landmarkBase,
  id: 'probe-park',
  category: 'park',
  interactions: ['visit', 'flex'],
}
const hall: Landmark = {
  ...landmarkBase,
  id: 'probe-hall',
  category: 'government',
  interactions: ['visit'],
}
const memorial: Landmark = {
  ...landmarkBase,
  id: 'probe-memorial',
  borough: 'manhattan',
  category: 'memorial',
  lookOnly: true,
}

function actionsOf(view: PlaceView): readonly PlaceAction[] {
  if (view.kind !== 'actions') throw new Error('expected an actions view')
  return view.actions
}

const ids = (view: PlaceView) => actionsOf(view).map((action) => action.id)
const action = (view: PlaceView, id: string) => {
  const found = actionsOf(view).find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no action ${id}`)
  return found
}

describe('placeActions: action sets by venue type', () => {
  it.each([
    ['bodega', {}, ['bodega-breakfast']],
    ['food-spot', {}, ['street-meal']],
    ['coffee-shop', { jobIds: ['barista'] }, ['coffee', 'shift-barista']],
    ['gym', {}, ['workout']],
    ['park', {}, ['walk-in-the-park']],
    ['thrift', { jobIds: ['retail'] }, ['shift-retail']],
    ['boutique', { jobIds: ['retail'] }, ['shift-retail', 'flex']],
    ['job-site', { jobIds: ['delivery'] }, ['shift-delivery']],
    ['job-site', { jobIds: ['junior-dev'] }, ['shift-junior-dev']],
    ['subway-station', {}, []],
  ] as const)('%s %o offers %o', (type, extra, expected) => {
    const view = placeActions(venue(type, extra as Partial<Venue>), snapshotWith(), config)
    expect(ids(view)).toEqual(expected)
  })

  it('a club offers a night inside with its configured cover and clout gain', () => {
    const view = placeActions(club, snapshotWith({ minute: at('23:00'), clout: 100 }), config)
    expect(ids(view)).toEqual(['club-night'])
    expect(action(view, 'club-night')).toMatchObject({
      kind: 'club-night',
      coverCharge: 15,
      cloutGain: 10,
      def: { durationMin: 120, cashCost: 15, energyCost: 15, statEffects: { mood: 10 } },
      block: null,
    })
  })

  it('catalog and place actions carry their configured costs', () => {
    const bodega = placeActions(venue('bodega'), snapshotWith(), config)
    expect(action(bodega, 'bodega-breakfast').def).toEqual(
      config.actions.catalog['bodega-breakfast'],
    )
    const coffee = placeActions(venue('coffee-shop'), snapshotWith(), config)
    expect(action(coffee, 'coffee').def).toEqual(config.place.actions.coffee)
  })

  it('a shift entry pays the configured wage', () => {
    const view = placeActions(venue('coffee-shop', { jobIds: ['barista'] }), snapshotWith(), config)
    expect(action(view, 'shift-barista')).toMatchObject({
      kind: 'shift',
      jobId: 'barista',
      wage: 56,
      def: { durationMin: 240, energyCost: 15, cashCost: 0 },
    })
  })

  it('throws for a club with no rule, and for an unknown configured action (fail fast)', () => {
    const lost = venue('club', { id: 'no-rule-club' } as Partial<Venue>)
    expect(() => placeActions(lost, snapshotWith(), config)).toThrow(/no rule/)
    const broken = {
      ...config,
      place: { ...config.place, venueActions: { ...config.place.venueActions, gym: ['nope'] } },
    }
    expect(() => placeActions(venue('gym'), snapshotWith(), broken)).toThrow(/unknown action/)
  })
})

describe('placeActions: opening hours on the personal clock', () => {
  const coffee = venue('coffee-shop', { jobIds: ['barista'] })

  it('an open venue reports its closing time and enables its actions', () => {
    const view = placeActions(coffee, snapshotWith({ minute: at('08:00') }), config)
    expect(view).toMatchObject({ kind: 'actions', hours: { status: 'open', closesAt: '19:00' } })
    expect(actionsOf(view).every((entry) => entry.block === null)).toBe(true)
  })

  it('a closed venue reports its opening time and blocks every action with it', () => {
    const view = placeActions(coffee, snapshotWith({ minute: at('23:00') }), config)
    expect(view).toMatchObject({ hours: { status: 'closed', opensAt: '06:00' } })
    for (const entry of actionsOf(view)) {
      expect(entry.block).toEqual({ code: 'closed', opensAt: '06:00' })
    }
  })

  it('uses the time of day on any game day', () => {
    expect(placeHoursNow(coffee, snapshotWith({ minute: at('08:00', 9) }), config)).toEqual({
      status: 'open',
      closesAt: '19:00',
    })
    expect(placeHoursNow(coffee, snapshotWith({ minute: at('05:59', 3) }), config)).toEqual({
      status: 'closed',
      opensAt: '06:00',
    })
  })

  it('the club opens at night only, past midnight included', () => {
    for (const clock of ['08:00', '12:00', '21:59', '04:00']) {
      expect(placeHoursNow(club, snapshotWith({ minute: at(clock) }), config).status).toBe('closed')
    }
    for (const clock of ['22:00', '23:30', '00:00', '03:59']) {
      expect(placeHoursNow(club, snapshotWith({ minute: at(clock) }), config).status).toBe('open')
    }
    const day = placeActions(club, snapshotWith({ minute: at('12:00'), clout: 100 }), config)
    expect(action(day, 'club-night').block).toEqual({ code: 'closed', opensAt: '22:00' })
  })

  it('24-hour venues and landmarks never close', () => {
    const allDay = venue('bodega', { hours: '24h' })
    expect(placeHoursNow(allDay, snapshotWith({ minute: at('03:00') }), config)).toEqual({
      status: 'always',
    })
    expect(placeHoursNow(bridge, snapshotWith({ minute: at('03:00') }), config)).toEqual({
      status: 'always',
    })
  })
})

describe('placeActions: the club door', () => {
  const night = at('23:00')

  it('refuses below the minimum clout level with the configured refusal copy key', () => {
    const view = placeActions(club, snapshotWith({ minute: night, clout: 99 }), config)
    expect(action(view, 'club-night').block).toEqual({
      code: 'door',
      requiredLevel: 'local',
      currentLevel: 'nobody',
      refusalKey: 'club.door.refused',
    })
  })

  it('admits at exactly the minimum level and above', () => {
    for (const clout of [100, 300, 5000]) {
      const view = placeActions(club, snapshotWith({ minute: night, clout }), config)
      expect(action(view, 'club-night').block).toBeNull()
    }
  })

  it('checks the cover only once the door lets the player in', () => {
    const refused = placeActions(club, snapshotWith({ minute: night, clout: 0, cash: 0 }), config)
    expect(action(refused, 'club-night').block?.code).toBe('door')
    const broke = placeActions(club, snapshotWith({ minute: night, clout: 100, cash: 14 }), config)
    expect(action(broke, 'club-night').block).toEqual({
      code: 'funds',
      required: 15,
      available: 14,
    })
    const exact = placeActions(club, snapshotWith({ minute: night, clout: 100, cash: 15 }), config)
    expect(action(exact, 'club-night').block).toBeNull()
  })

  it('a closed club reports closed before the door', () => {
    const view = placeActions(club, snapshotWith({ minute: at('12:00'), clout: 0 }), config)
    expect(action(view, 'club-night').block?.code).toBe('closed')
  })
})

describe('placeActions: funds, energy, job locks and boroughs', () => {
  it('blocks an action the player cannot afford, then one they are too tired for', () => {
    const gym = venue('gym')
    expect(action(placeActions(gym, snapshotWith({ cash: 7 }), config), 'workout').block).toEqual({
      code: 'funds',
      required: 8,
      available: 7,
    })
    const tired = placeActions(gym, snapshotWith({ stats: { energy: 19 } }), config)
    expect(action(tired, 'workout').block).toEqual({
      code: 'energy',
      required: 20,
      available: 19,
    })
    expect(action(placeActions(gym, snapshotWith({ cash: 8 }), config), 'workout').block).toBeNull()
  })

  it('blocks a locked job with its lock', () => {
    const labs = venue('job-site', { jobIds: ['junior-dev'] })
    expect(action(placeActions(labs, snapshotWith(), config), 'shift-junior-dev').block).toEqual({
      code: 'job-locked',
      lock: { jobId: 'junior-dev', requiredLevel: 'local', currentLevel: 'nobody' },
    })
    const local = placeActions(labs, snapshotWith({ clout: 100 }), config)
    expect(action(local, 'shift-junior-dev').block).toBeNull()
  })

  it('a place in a locked borough blocks every action with the borough reason first', () => {
    const brooklynClub = { ...club, borough: 'brooklyn' } as Venue
    const view = placeActions(brooklynClub, snapshotWith({ minute: at('12:00') }), config)
    expect(view).toMatchObject({ access: { status: 'locked', required: 'local' } })
    expect(action(view, 'club-night').block).toEqual({
      code: 'borough-locked',
      access: { status: 'locked', required: 'local', current: 'nobody' },
    })
    const unlocked = placeActions(brooklynClub, snapshotWith({ clout: 100 }), config)
    expect(action(unlocked, 'club-night').block?.code).toBe('closed')
  })

  it('an expanding-soon borough blocks its landmarks', () => {
    const ferry = { ...bridge, borough: 'staten-island' } as Landmark
    const view = placeActions(ferry, snapshotWith({ clout: 5000 }), config)
    expect(action(view, 'visit').block).toEqual({
      code: 'borough-locked',
      access: { status: 'expanding-soon' },
    })
  })
})

describe('placeActions: landmarks', () => {
  it('non-memorial landmarks that allow visit offer Visit with the configured time and mood', () => {
    for (const landmark of [bridge, park, hall]) {
      const view = placeActions(landmark, snapshotWith({ minute: at('02:00') }), config)
      expect(view).toMatchObject({ kind: 'actions', hours: { status: 'always' } })
      expect(action(view, 'visit')).toMatchObject({
        kind: 'visit',
        def: { durationMin: 60, cashCost: 0, energyCost: 5, statEffects: { mood: 10 } },
        block: null,
      })
    }
  })

  it('memorials are look-only: no actions at all, at any clout or time', () => {
    for (const clout of [0, 300, 5000]) {
      for (const minute of [at('03:00'), at('12:00'), at('23:00')]) {
        expect(placeActions(memorial, snapshotWith({ clout, minute }), config)).toEqual({
          kind: 'look-only',
        })
      }
    }
  })

  it('exposes a flex multiplier from config for landmarks that allow flex', () => {
    expect(flexMultiplier(bridge, config)).toBe(2)
    expect(flexMultiplier(park, config)).toBe(1)
  })

  it('has no flex multiplier for memorials, landmarks without flex, or venues', () => {
    expect(flexMultiplier(memorial, config)).toBeNull()
    expect(flexMultiplier(hall, config)).toBeNull()
    expect(flexMultiplier(club, config)).toBeNull()
  })
})

describe('performPlaceAction', () => {
  it('a landmark visit moves the clock by its duration and lifts mood', () => {
    const before = snapshotWith({ minute: at('10:00'), stats: { mood: 50 } })
    const result = performPlaceAction(before, bridge, 'visit', config)
    if (!result.ok) throw new Error(result.error.code)
    expect(result.durationMin).toBe(60)
    expect(result.snapshot.clock.minute).toBe(before.clock.minute + 60)
    // One game hour of decay (2) lands before the visit's +10.
    expect(result.snapshot.player.stats.mood).toBe(58)
    expect(result.snapshot.player.stats.energy).toBe(100 - 5 - 3)
    expect(result.snapshot.player.cash).toBe(before.player.cash)
    expect(result.cloutGained).toBe(0)
  })

  it('a first visit records the landmark at the minute it ended; later visits keep it (S15)', () => {
    const before = snapshotWith({ minute: at('10:00') })
    expect(before.player.visited).toEqual({})
    const first = performPlaceAction(before, bridge, 'visit', config)
    if (!first.ok) throw new Error(first.error.code)
    const ended = first.snapshot.clock.minute
    expect(first.snapshot.player.visited).toEqual({ 'probe-bridge': ended })
    const again = performPlaceAction(first.snapshot, bridge, 'visit', config)
    if (!again.ok) throw new Error(again.error.code)
    expect(again.snapshot.player.visited).toEqual({ 'probe-bridge': ended })
    const park2 = performPlaceAction(again.snapshot, park, 'visit', config)
    if (!park2.ok) throw new Error(park2.error.code)
    expect(Object.keys(park2.snapshot.player.visited).sort()).toEqual([
      'probe-bridge',
      'probe-park',
    ])
  })

  it('no other action records a visit, and a memorial never does (it has no Visit)', () => {
    const before = snapshotWith({ minute: at('12:00') })
    const flexed = performPlaceAction(before, bridge, 'flex', config)
    if (!flexed.ok) throw new Error(flexed.error.code)
    expect(flexed.snapshot.player.visited).toEqual({})
    for (const id of ['visit', 'flex', 'look']) {
      const refused = performPlaceAction(before, memorial, id, config)
      expect(refused.ok).toBe(false)
    }
  })

  it('a club night pays the cover, moves the clock and adds the clout gain', () => {
    const before = snapshotWith({ minute: at('23:00'), clout: 100, cash: 50 })
    const result = performPlaceAction(before, club, 'club-night', config)
    if (!result.ok) throw new Error(result.error.code)
    expect(result.snapshot.player.cash).toBe(35)
    expect(totalClout(result.snapshot.player, config)).toBe(110)
    expect(result.cloutGained).toBe(10)
    expect(result.snapshot.clock.minute).toBe(before.clock.minute + 120)
  })

  it('the door refusal changes nothing', () => {
    const before = snapshotWith({ minute: at('23:00'), clout: 0 })
    const result = performPlaceAction(before, club, 'club-night', config)
    expect(result).toMatchObject({ ok: false, error: { code: 'BLOCKED', block: { code: 'door' } } })
  })

  it('a closed venue refuses with its opening time', () => {
    const result = performPlaceAction(
      snapshotWith({ minute: at('23:00') }),
      venue('coffee-shop'),
      'coffee',
      config,
    )
    expect(result).toEqual({
      ok: false,
      error: { code: 'BLOCKED', block: { code: 'closed', opensAt: '06:00' } },
    })
  })

  it('a shift at a venue pays the wage through workShift', () => {
    const before = snapshotWith({ minute: at('08:00') })
    const result = performPlaceAction(
      before,
      venue('coffee-shop', { jobIds: ['barista'] }),
      'shift-barista',
      config,
    )
    if (!result.ok) throw new Error(result.error.code)
    expect(result.wage).toBe(56)
    expect(result.snapshot.player.cash).toBe(before.player.cash + 56)
    expect(result.snapshot.clock.minute).toBe(before.clock.minute + 240)
  })

  it('a consumable charges its price and applies its effects', () => {
    const before = snapshotWith({ minute: at('08:00'), stats: { hunger: 20 } })
    const result = performPlaceAction(before, venue('bodega'), 'bodega-breakfast', config)
    if (!result.ok) throw new Error(result.error.code)
    expect(result.snapshot.player.cash).toBe(before.player.cash - 6)
    expect(result.snapshot.player.stats.hunger).toBe(20 + 40)
  })

  it('a memorial refuses every action as look-only', () => {
    for (const id of ['visit', 'flex', 'club-night']) {
      expect(performPlaceAction(snapshotWith({ clout: 5000 }), memorial, id, config)).toEqual({
        ok: false,
        error: { code: 'LOOK_ONLY' },
      })
    }
  })

  it('an action the place does not offer is unknown', () => {
    expect(performPlaceAction(snapshotWith(), venue('bodega'), 'visit', config)).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_PLACE_ACTION', actionId: 'visit' },
    })
  })
})

describe('club clout at most once per game night (orchestrator ruling, S09)', () => {
  const lateHours = { open: '22:00', close: '04:00' } as const

  it('clubNightKey names the day the opening window started on', () => {
    expect(clubNightKey(lateHours, at('22:00', 4), config)).toBe(5)
    expect(clubNightKey(lateHours, at('23:59', 4), config)).toBe(5)
    expect(clubNightKey(lateHours, at('00:00', 5), config)).toBe(5)
    expect(clubNightKey(lateHours, at('03:59', 5), config)).toBe(5)
    expect(clubNightKey(lateHours, at('22:00', 5), config)).toBe(6)
    // Day 1 before close belongs to the night before the game began.
    expect(clubNightKey(lateHours, at('01:00', 0), config)).toBe(0)
    expect(clubNightKey({ open: '18:00', close: '23:00' }, at('19:00', 2), config)).toBe(3)
    expect(clubNightKey('24h', at('03:00', 2), config)).toBe(3)
  })

  function enter(snapshot: GameSnapshot) {
    const result = performPlaceAction(snapshot, club, 'club-night', config)
    if (!result.ok) throw new Error(result.error.code)
    return result
  }

  it('the first entry of a night earns clout and records the night', () => {
    const first = enter(snapshotWith({ minute: at('22:00', 4), clout: 100, cash: 100 }))
    expect(first.cloutGained).toBe(10)
    expect(first.snapshot.player.clubNights).toEqual({ 'probe-club': 5 })
  })

  it('a second entry the same night (after midnight) pays the cover, time and mood but no clout', () => {
    const first = enter(snapshotWith({ minute: at('22:00', 4), clout: 100, cash: 100 }))
    const later = { ...first.snapshot, clock: { minute: at('00:30', 5), remainderMs: 0 } }
    const view = placeActions(club, later, config)
    expect(action(view, 'club-night')).toMatchObject({
      cloutGain: 0,
      cloutEarnedTonight: true,
      nightKey: 5,
      block: null,
    })
    const second = enter(later)
    expect(second.cloutGained).toBe(0)
    expect(totalClout(second.snapshot.player, config)).toBe(totalClout(later.player, config))
    expect(second.snapshot.player.cash).toBe(later.player.cash - 15)
    expect(second.snapshot.clock.minute).toBe(later.clock.minute + 120)
    expect(second.snapshot.player.clubNights).toEqual({ 'probe-club': 5 })
  })

  it('the next night pays out again', () => {
    const first = enter(snapshotWith({ minute: at('22:00', 4), clout: 100, cash: 100 }))
    const nextNight = { ...first.snapshot, clock: { minute: at('22:00', 5), remainderMs: 0 } }
    const again = enter(nextNight)
    expect(again.cloutGained).toBe(10)
    expect(again.snapshot.player.clubNights).toEqual({ 'probe-club': 6 })
  })

  it('each club keeps its own night', () => {
    const other = { ...club, id: 'other-club' } as Venue
    const twoClubs: EngineConfig = {
      ...config,
      place: {
        ...config.place,
        clubs: { ...config.place.clubs, 'other-club': config.place.clubs['probe-club']! },
      },
    }
    const first = enter(snapshotWith({ minute: at('22:00', 4), clout: 100, cash: 100 }))
    const result = performPlaceAction(first.snapshot, other, 'club-night', twoClubs)
    if (!result.ok) throw new Error(result.error.code)
    expect(result.cloutGained).toBe(10)
    expect(result.snapshot.player.clubNights).toEqual({ 'probe-club': 5, 'other-club': 5 })
  })
})

describe('the player must be there (DEC-22)', () => {
  const bodega = venue('bodega')

  it('away, every action is blocked with `away`, after the rule reasons and before funds', () => {
    const view = placeActionsAnywhere(bodega, snapshotWith({ cash: 0 }), config)
    expect(actionsOf(view).every((entry) => entry.block?.code === 'away')).toBe(true)
    const here = placeActionsAnywhere(bodega, atPlace(snapshotWith({ cash: 0 }), bodega.id), config)
    expect(action(here, 'bodega-breakfast').block).toMatchObject({ code: 'funds' })
  })

  it('a closed place says it is closed before it says the player is away', () => {
    const coffee = venue('coffee-shop')
    const view = placeActionsAnywhere(coffee, snapshotWith({ minute: at('23:00') }), config)
    expect(actionsOf(view).every((entry) => entry.block?.code === 'closed')).toBe(true)
  })

  it('at another place still counts as away', () => {
    const view = placeActionsAnywhere(bodega, atPlace(snapshotWith(), 'somewhere-else'), config)
    expect(action(view, 'bodega-breakfast').block).toEqual({ code: 'away' })
  })

  it('performPlaceAction re-checks it: refused and nothing changes', () => {
    const before = snapshotWith()
    expect(performPlaceActionAnywhere(before, bodega, 'bodega-breakfast', config)).toEqual({
      ok: false,
      error: { code: 'BLOCKED', block: { code: 'away' } },
    })
    const done = performPlaceActionAnywhere(
      atPlace(before, bodega.id),
      bodega,
      'bodega-breakfast',
      config,
    )
    expect(done.ok).toBe(true)
    if (done.ok)
      expect(done.snapshot.player.location).toEqual({ kind: 'place', placeId: bodega.id })
  })
})
