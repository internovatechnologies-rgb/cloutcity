/**
 * S09 rule probes against the shipped data and balance: opening-hour boundaries for every real
 * venue on the personal clock, the club door at every real club (level edge, cover edge, clout
 * applied once, a night that runs past close), memorials refusing any crafted action id,
 * borough gating of every real place, and button durations agreeing with what the engine
 * applies when the player is slowed. Numbers come from data/config, never literals.
 */
import { describe, expect, it } from 'vitest'
import { findCloutLevel, totalClout } from '@/engine/clout'
import { engineConfig } from '@/engine/config'
import { initialSnapshot, type GameSnapshot } from '@/engine/game'
import type { PlaceAction, PlaceActionBlock } from '@/engine/placeActions'
import { placeAllows, type PlaceHook } from '@/engine/places'
import {
  performPlaceActionHere as performPlaceAction,
  placeActionsHere as placeActions,
  withClout,
} from '@/engine/test-support'
import { boroughAccess } from '@/engine/boroughs'
import { createCopy } from '@/lib/copy'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { cloutLevelName } from '@/lib/economyCopy'
import {
  formatDuration,
  placeActionAccessibleName,
  placeActionDetails,
  placeBlockReason,
} from './placeActionCopy'
import { boroughClosedReason, findPlace, landmarks, venues } from './places'

const plain = { copy: createCopy(baseCopy, { id: 'none', strings: {} }) }
const nyc = { copy: createCopy(baseCopy, slangPacks.nyc ?? { id: 'none', strings: {} }) }

const DAY = 24 * 60
const minuteOf = (clock: string) => {
  const [h = 0, m = 0] = clock.split(':').map(Number)
  return h * 60 + m
}
const wrap = (minute: number) => ((minute % DAY) + DAY) % DAY

/** Clout high enough that every clout-gated borough and club door is open. */
const MAX_CLOUT = Math.max(...engineConfig.clout.levels.map((level) => level.minClout))

function snapshotAt(
  minuteOfDay: number,
  overrides: {
    clout?: number
    cash?: number
    day?: number
    stats?: Partial<GameSnapshot['player']['stats']>
  } = {},
): GameSnapshot {
  const base = initialSnapshot(engineConfig)
  const snapshot = {
    clock: { minute: (overrides.day ?? 0) * DAY + minuteOfDay, remainderMs: 0 },
    player: {
      ...base.player,
      cash: overrides.cash ?? base.player.cash,
      stats: { ...base.player.stats, ...overrides.stats },
    },
  }
  return withClout(snapshot, overrides.clout ?? MAX_CLOUT, engineConfig)
}

const cloutOf = (snapshot: GameSnapshot) => totalClout(snapshot.player, engineConfig)

function place(id: string) {
  const found = findPlace(id)
  if (found === undefined) throw new Error(`no place ${id}`)
  return found
}

function actionsAt(id: string, snapshot: GameSnapshot): readonly PlaceAction[] {
  const view = placeActions(place(id), snapshot, engineConfig)
  if (view.kind !== 'actions') throw new Error(`${id} is look-only`)
  return view.actions
}

function actionAt(id: string, actionId: string, snapshot: GameSnapshot): PlaceAction {
  const found = actionsAt(id, snapshot).find((action) => action.id === actionId)
  if (found === undefined) throw new Error(`no ${actionId} at ${id}`)
  return found
}

const timedVenues = venues.flatMap((venue) =>
  venue.hours === '24h' ? [] : [{ venue, open: venue.hours.open, close: venue.hours.close }],
)
const clubs = venues.filter((venue) => venue.type === 'club')

describe('opening hours of every real venue on the personal clock', () => {
  it.each(timedVenues.map((entry) => [entry.venue.id, entry] as const))(
    '%s opens at its opening minute and closes at its closing minute',
    (_, { venue, open, close }) => {
      const view = (minute: number, day = 0) =>
        placeActions(venue, snapshotAt(wrap(minute), { day }), engineConfig)
      // The minute before opening and the closing minute itself are closed, with the opening time.
      for (const minute of [minuteOf(open) - 1, minuteOf(close)]) {
        expect(view(minute)).toMatchObject({ hours: { status: 'closed', opensAt: open } })
      }
      // The opening minute and the last minute before close are open, with the closing time.
      for (const minute of [minuteOf(open), minuteOf(close) - 1]) {
        expect(view(minute)).toMatchObject({ hours: { status: 'open', closesAt: close } })
      }
      // The same on a later day of the personal clock.
      expect(view(minuteOf(open), 9)).toMatchObject({ hours: { status: 'open' } })
      expect(view(minuteOf(close), 9)).toMatchObject({ hours: { status: 'closed' } })
    },
  )

  it('every action at a closed venue is blocked with the opening time, before anything else', () => {
    for (const { venue, open, close } of timedVenues) {
      // Broke, exhausted and at clout 0: closed still wins for an open-borough venue.
      const snapshot = snapshotAt(minuteOf(close), { clout: MAX_CLOUT, cash: 0 })
      for (const action of actionsAt(venue.id, snapshot)) {
        expect(action.block, `${venue.id} ${action.id}`).toEqual({ code: 'closed', opensAt: open })
      }
    }
  })

  it('past-midnight venues are open on both sides of midnight and closed between close and open', () => {
    const pastMidnight = timedVenues.filter(({ open, close }) => minuteOf(close) < minuteOf(open))
    expect(pastMidnight.map(({ venue }) => venue.id)).toEqual(
      expect.arrayContaining(clubs.map((club) => club.id)),
    )
    for (const { venue, open, close } of pastMidnight) {
      for (const minute of [minuteOf(open), DAY - 1, 0, minuteOf(close) - 1]) {
        expect(placeActions(venue, snapshotAt(minute), engineConfig)).toMatchObject({
          hours: { status: 'open', closesAt: close },
        })
      }
      const between = Math.floor((minuteOf(close) + minuteOf(open)) / 2)
      expect(placeActions(venue, snapshotAt(between), engineConfig)).toMatchObject({
        hours: { status: 'closed', opensAt: open },
      })
    }
  })

  it('every club opens at 22:00 and closes at 04:00', () => {
    for (const club of clubs) expect(club.hours).toEqual({ open: '22:00', close: '04:00' })
  })

  it('24-hour venues and visitable landmarks are never closed, at any minute', () => {
    const always = [
      ...venues.filter((venue) => venue.hours === '24h'),
      ...landmarks.filter((landmark) => landmark.category !== 'memorial'),
    ]
    for (const entry of always) {
      for (let minute = 0; minute < DAY; minute += 15) {
        const view = placeActions(entry, snapshotAt(minute), engineConfig)
        expect(view, `${entry.id} at ${minute}`).toMatchObject({ hours: { status: 'always' } })
        if (view.kind !== 'actions') throw new Error('expected actions')
        for (const action of view.actions) expect(action.block?.code).not.toBe('closed')
      }
    }
  })

  it('a non-memorial landmark in an open borough can always be visited', () => {
    for (const landmark of landmarks) {
      if (landmark.category === 'memorial') continue
      const snapshot = snapshotAt(minuteOf('03:30'))
      if (boroughAccess(landmark.borough, cloutOf(snapshot), engineConfig).status !== 'open') {
        continue
      }
      expect(actionAt(landmark.id, 'visit', snapshot).block, landmark.id).toBeNull()
    }
  })
})

describe('the club door at every real club', () => {
  const NIGHT = minuteOf('23:00')

  function doorRule(clubId: string) {
    const rule = engineConfig.place.clubs[clubId]
    if (rule === undefined) throw new Error(`no club rule for ${clubId}`)
    const level = findCloutLevel(rule.minCloutLevel, engineConfig)
    if (level === undefined) throw new Error(`unknown level ${rule.minCloutLevel}`)
    return { rule, level }
  }

  it.each(clubs.map((club) => [club.id]))(
    '%s refuses one point below its level in voice, and admits at the level',
    (clubId) => {
      const { rule, level } = doorRule(clubId)
      const below = snapshotAt(NIGHT, { clout: level.minClout - 1 })
      const refused = actionAt(clubId, 'club-night', below)
      // The borough must already be open one point below, or the door is never reached.
      if (
        boroughAccess(place(clubId).borough, level.minClout - 1, engineConfig).status === 'open'
      ) {
        expect(refused.block).toMatchObject({
          code: 'door',
          requiredLevel: rule.minCloutLevel,
          refusalKey: rule.refusalKey,
        })
        if (refused.block === null) throw new Error('expected a refusal')
        const required = cloutLevelName(rule.minCloutLevel, plain)
        for (const options of [plain, nyc]) {
          const reason = placeBlockReason(refused.block, place(clubId), options)
          expect(reason).toContain(cloutLevelName(rule.minCloutLevel, options))
          expect(reason).not.toMatch(/[{}]/)
        }
        // The nyc pack has its own voice for the door; plain stays the base string.
        expect(placeBlockReason(refused.block, place(clubId), nyc)).not.toBe(
          placeBlockReason(refused.block, place(clubId), plain),
        )
        expect(placeBlockReason(refused.block, place(clubId), plain)).toContain(required)
        const after = performPlaceAction(below, place(clubId), 'club-night', engineConfig)
        expect(after).toEqual({ ok: false, error: { code: 'BLOCKED', block: refused.block } })
      } else {
        expect(refused.block?.code).toBe('borough-locked')
      }

      const atLevel = snapshotAt(NIGHT, { clout: level.minClout })
      expect(actionAt(clubId, 'club-night', atLevel).block).toBeNull()
    },
  )

  it.each(clubs.map((club) => [club.id]))(
    '%s admits with exactly the cover, and refuses $1 short without changing anything',
    (clubId) => {
      const { rule, level } = doorRule(clubId)
      const exact = snapshotAt(NIGHT, { clout: level.minClout, cash: rule.coverCharge })
      const result = performPlaceAction(exact, place(clubId), 'club-night', engineConfig)
      if (!result.ok) throw new Error(result.error.code)
      expect(result.snapshot.player.cash).toBe(0)
      // The clout gain lands once, exactly as configured.
      expect(result.cloutGained).toBe(rule.cloutGain)
      expect(cloutOf(result.snapshot)).toBe(level.minClout + rule.cloutGain)
      expect(result.snapshot.clock.minute).toBe(exact.clock.minute + rule.durationMin)

      const short = snapshotAt(NIGHT, { clout: level.minClout, cash: rule.coverCharge - 1 })
      expect(actionAt(clubId, 'club-night', short).block).toEqual({
        code: 'funds',
        required: rule.coverCharge,
        available: rule.coverCharge - 1,
      })
      expect(performPlaceAction(short, place(clubId), 'club-night', engineConfig)).toMatchObject({
        ok: false,
        error: { code: 'BLOCKED', block: { code: 'funds' } },
      })
    },
  )

  it('the door is checked before the cover: a broke player below the level hears the door', () => {
    const { level } = doorRule('glowmatic')
    const view = actionAt('glowmatic', 'club-night', snapshotAt(NIGHT, { clout: 0, cash: 0 }))
    expect(view.block?.code).toBe('door')
    expect(level.minClout).toBeGreaterThan(0)
  })

  it('only the start time is checked: a night starting a minute before close runs past it', () => {
    const { rule, level } = doorRule('glowmatic')
    const close = minuteOf('04:00')
    const last = snapshotAt(close - 1, { clout: level.minClout, day: 1 })
    const result = performPlaceAction(last, place('glowmatic'), 'club-night', engineConfig)
    if (!result.ok) throw new Error(result.error.code)
    expect(result.snapshot.clock.minute).toBe(last.clock.minute + rule.durationMin)
    expect(result.cloutGained).toBe(rule.cloutGain)
    // At the closing minute the door is shut with the opening time.
    const atClose = snapshotAt(close, { clout: level.minClout, day: 1 })
    expect(actionAt('glowmatic', 'club-night', atClose).block).toEqual({
      code: 'closed',
      opensAt: '22:00',
    })
  })

  it('back-to-back nights each re-check the rules, and the chain stops when the club closes', () => {
    const { rule, level } = doorRule('glowmatic')
    let snapshot = snapshotAt(minuteOf('22:00'), { clout: level.minClout, cash: 1000 })
    let nights = 0
    for (;;) {
      const before = snapshot
      const result = performPlaceAction(before, place('glowmatic'), 'club-night', engineConfig)
      if (!result.ok) {
        expect(result.error).toMatchObject({ code: 'BLOCKED' })
        break
      }
      nights += 1
      // Orchestrator ruling (S09, 2026-10-06): a club pays out clout at most once per game
      // night; later entries the same night still pay the cover but earn no clout.
      expect(cloutOf(result.snapshot)).toBe(cloutOf(before) + (nights === 1 ? rule.cloutGain : 0))
      expect(result.snapshot.player.cash).toBeLessThanOrEqual(before.player.cash - rule.coverCharge)
      snapshot = result.snapshot
      if (nights > 24) throw new Error('the club never stopped admitting')
    }
    // Every entry was paid for; the whole chain is one game night, so clout landed once
    // (orchestrator ruling, S09: at most once per club per game night).
    expect(cloutOf(snapshot)).toBe(level.minClout + rule.cloutGain)
    expect(nights).toBeGreaterThan(0)
  })
})

describe('memorials refuse everything', () => {
  const memorials = landmarks.filter((landmark) => landmark.category === 'memorial')

  it('there is at least one memorial (the 9/11 Memorial)', () => {
    expect(memorials.map((memorial) => memorial.id)).toContain('september-11-memorial')
  })

  it('allows no hook, offers no action, and refuses any action id, crafted ones included', () => {
    const crafted = [
      'visit',
      'flex',
      'emote',
      'club-night',
      'shift-barista',
      'coffee',
      'bodega-breakfast',
      '',
      '__proto__',
      'constructor',
      'toString',
    ]
    const hooks: PlaceHook[] = ['visit', 'flex', 'emote', 'events', 'crime']
    for (const memorial of memorials) {
      for (const hook of hooks) expect(placeAllows(memorial, hook)).toBe(false)
      for (const clout of [0, MAX_CLOUT]) {
        const snapshot = snapshotAt(minuteOf('12:00'), { clout })
        expect(placeActions(memorial, snapshot, engineConfig)).toEqual({ kind: 'look-only' })
        for (const id of crafted) {
          expect(performPlaceAction(snapshot, memorial, id, engineConfig)).toEqual({
            ok: false,
            error: { code: 'LOOK_ONLY' },
          })
        }
      }
    }
  })

  it('a crafted action id at an ordinary venue is unknown, never a prototype lookup', () => {
    const snapshot = snapshotAt(minuteOf('23:00'))
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'shift-', '']) {
      for (const placeId of ['glowmatic', 'steam-vent-coffee', 'flushing-meadows']) {
        expect(performPlaceAction(snapshot, place(placeId), id, engineConfig)).toEqual({
          ok: false,
          error: { code: 'UNKNOWN_PLACE_ACTION', actionId: id },
        })
      }
    }
  })
})

describe('borough gating of every real place', () => {
  const NOON = minuteOf('12:00')
  const allPlaces = [...venues, ...landmarks.filter((l) => l.category !== 'memorial')]

  it('at clout 0, every action outside an open borough is borough-locked, named in the button', () => {
    const snapshot = snapshotAt(NOON, { clout: 0 })
    let checked = 0
    for (const entry of allPlaces) {
      const access = boroughAccess(entry.borough, 0, engineConfig)
      if (access.status === 'open') continue
      const reason = boroughClosedReason(entry.borough, access, plain)
      if (reason === null) throw new Error(`no closed reason for ${entry.borough}`)
      for (const action of actionsAt(entry.id, snapshot)) {
        checked += 1
        expect(action.block, `${entry.id} ${action.id}`).toEqual({
          code: 'borough-locked',
          access,
        })
        expect(placeActionAccessibleName(action, entry, snapshot, plain)).toContain(reason)
        expect(performPlaceAction(snapshot, entry, action.id, engineConfig)).toMatchObject({
          ok: false,
          error: { code: 'BLOCKED', block: { code: 'borough-locked' } },
        })
      }
    }
    // Brooklyn and Manhattan places, plus the teaser boroughs' landmarks.
    expect(checked).toBeGreaterThan(10)
  })

  it('teaser boroughs stay closed at any clout, with their teaser as the reason', () => {
    const teasers = allPlaces.filter(
      (entry) => boroughAccess(entry.borough, MAX_CLOUT, engineConfig).status === 'expanding-soon',
    )
    expect(teasers.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['bronx-ballpark', 'staten-island-ferry']),
    )
    const snapshot = snapshotAt(NOON, { clout: MAX_CLOUT })
    for (const entry of teasers) {
      for (const action of actionsAt(entry.id, snapshot)) {
        expect(action.block).toEqual({
          code: 'borough-locked',
          access: { status: 'expanding-soon' },
        })
      }
    }
  })
})

describe('slowed durations: the button says what the engine applies', () => {
  const tiredStates = [
    { mood: 0 },
    { energy: 0 },
    { energy: 0, mood: 0 },
    { hunger: 0, mood: 0 },
  ] as const

  it('for every enabled action at every real place, the duration shown is the duration run', () => {
    let slowed = 0
    for (const entry of [...venues, ...landmarks]) {
      if ('category' in entry && entry.category === 'memorial') continue
      for (const stats of tiredStates) {
        for (const minute of [minuteOf('12:00'), minuteOf('23:00')]) {
          const snapshot = snapshotAt(minute, { stats, cash: 1000 })
          const view = placeActions(entry, snapshot, engineConfig)
          if (view.kind !== 'actions') continue
          for (const action of view.actions) {
            if (action.block !== null) continue
            const result = performPlaceAction(snapshot, entry, action.id, engineConfig)
            if (!result.ok) throw new Error(`${entry.id} ${action.id}: ${result.error.code}`)
            const shown = placeActionDetails(action, snapshot, plain).split(', ')[0]
            expect(shown, `${entry.id} ${action.id}`).toBe(
              formatDuration(result.durationMin, plain),
            )
            expect(result.snapshot.clock.minute - snapshot.clock.minute).toBe(result.durationMin)
            if (result.durationMin > action.def.durationMin) slowed += 1
          }
        }
      }
    }
    // The probe really exercised the slowdown, not only base durations.
    expect(slowed).toBeGreaterThan(0)
  })
})

describe('borough-locked reason never blank', () => {
  it('falls back to plain locked-borough copy when the access says open', () => {
    const anyPlace = venues[0]
    if (anyPlace === undefined) throw new Error('no venues')
    // The engine never reports an open borough as a block; a block that disagrees with its
    // access (a crafted or stale value) must still give the player a reason, never ''.
    const stale = {
      code: 'borough-locked',
      access: { status: 'open' },
    } as unknown as PlaceActionBlock
    for (const options of [plain, nyc]) {
      const reason = placeBlockReason(stale, anyPlace, options)
      expect(reason.trim()).not.toBe('')
      expect(reason).not.toMatch(/[{}]/)
      expect(reason).toBe(options.copy('place.blocked.boroughLocked'))
    }
  })
})
