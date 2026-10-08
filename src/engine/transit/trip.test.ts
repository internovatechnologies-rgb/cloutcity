/**
 * S08 part 2: trips between the player's spots (home and places) — committed at once (DEC-22),
 * location and generator moved with them, rent returned (BUG-1 pattern), destinations gated by
 * borough, and the straight taxi estimate without the transit world.
 */
import { describe, expect, it } from 'vitest'
import { calendar, minutesPerDay } from '../clock'
import { engineConfig as engine } from '../config'
import { HOME_LOCATION, initialSnapshot, type GameSnapshot } from '../game'
import { nextRentDueDay } from '../rent'
import { atPlace, withClout } from '../test-support'
import { mapPlaces } from '@/lib/world/places'
import { tripEnd, type TripEnd } from '@/lib/world/tripEnds'
import { transitConfig } from './config'
import { planTrip } from './plan'
import { NOON, TEST_TRANSIT, testWorld } from './test-fixtures'
import { planDirect, takeTrip, tripOptions } from './trip'
import { travel } from './travel'

const world = testWorld()
const DAY = minutesPerDay(engine)
const DELI = 'late-lantern-deli'

function end(id: string, snapshot: GameSnapshot): TripEnd {
  const found = tripEnd(
    id === 'home' ? HOME_LOCATION : { kind: 'place', placeId: id },
    snapshot.player.home,
  )
  if (found === undefined) throw new Error(`no spot ${id}`)
  return found
}

function at(minuteOfDay: number, cash = 150): GameSnapshot {
  const base = initialSnapshot(engine)
  return { clock: { minute: DAY + minuteOfDay, remainderMs: 0 }, player: { ...base.player, cash } }
}

const manhattanPlace = mapPlaces().find((place) => place.borough === 'manhattan')
if (manhattanPlace === undefined) throw new Error('no Manhattan place')

describe('takeTrip', () => {
  it('walks home to the deli: clock, location and generator move at once; walking is free', () => {
    const before = at(NOON)
    const to = end(DELI, before)
    const result = takeTrip(
      before,
      { from: end('home', before).stop.point, to: to.stop, mode: 'walk' },
      { world },
      engine,
      TEST_TRANSIT,
    )
    if (!result.ok) throw new Error(result.error.code)
    expect(result.snapshot.player.location).toEqual({ kind: 'place', placeId: DELI })
    expect(result.from).toEqual(HOME_LOCATION)
    expect(result.to).toEqual({ kind: 'place', placeId: DELI })
    expect(result.snapshot.player.cash).toBe(before.player.cash)
    expect(result.snapshot.clock.minute - before.clock.minute).toBe(result.durationMin)
    expect(result.durationMin).toBeGreaterThan(0)
    expect(result.delay).toBeNull()
    expect(result.direct).toBe(false)
  })

  it('pays the fare, and saves the generator state so a reload cannot re-roll', () => {
    const before = atPlace(at(NOON), DELI)
    const result = takeTrip(
      before,
      { from: end(DELI, before).stop.point, to: end('home', before).stop, mode: 'taxi' },
      { world },
      engine,
      TEST_TRANSIT,
    )
    if (!result.ok) throw new Error(result.error.code)
    expect(result.snapshot.player.cash).toBe(before.player.cash - result.route.fare)
    expect(result.snapshot.player.location).toEqual(HOME_LOCATION)
    expect(Number.isInteger(result.snapshot.player.transit.rngState)).toBe(true)
    // Same save, same minute: the same trip replays exactly.
    const again = takeTrip(
      before,
      { from: end(DELI, before).stop.point, to: end('home', before).stop, mode: 'taxi' },
      { world },
      engine,
      TEST_TRANSIT,
    )
    expect(again).toEqual(result)
  })

  it('refuses where the player already is, changing nothing', () => {
    const before = atPlace(at(NOON), DELI)
    const to = end(DELI, before)
    expect(
      takeTrip(
        before,
        { from: to.stop.point, to: to.stop, mode: 'walk' },
        { world },
        engine,
        TEST_TRANSIT,
      ),
    ).toEqual({ ok: false, error: { code: 'ALREADY_HERE' } })
  })

  it('refuses a place in a borough the player cannot enter yet, and allows it once open', () => {
    const before = at(NOON, 10_000)
    const to = end(manhattanPlace.id, before)
    const request = { from: end('home', before).stop.point, to: to.stop, mode: 'taxi' } as const
    const locked = takeTrip(before, request, { world }, engine, TEST_TRANSIT)
    expect(locked).toMatchObject({ ok: false, error: { code: 'BOROUGH_LOCKED' } })
    const top = Math.max(...engine.clout.levels.map((level) => level.minClout))
    expect(
      takeTrip(withClout(before, top, engine), request, { world }, engine, TEST_TRANSIT).ok,
    ).toBe(true)
  })

  it('refuses a fare the player cannot pay without drawing or moving anything', () => {
    const before = at(NOON, 0)
    const result = takeTrip(
      before,
      { from: end('home', before).stop.point, to: end(DELI, before).stop, mode: 'taxi' },
      { world },
      engine,
      TEST_TRANSIT,
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'INSUFFICIENT_FUNDS' } })
  })

  it('returns the rent that fell due on the way (BUG-1 pattern)', () => {
    const base = at(NOON, 1000)
    const due = nextRentDueDay(base.clock.minute, engine)
    const before: GameSnapshot = {
      ...base,
      clock: { minute: (due - 1) * DAY - 2, remainderMs: 0 },
    }
    const result = takeTrip(
      before,
      { from: end('home', before).stop.point, to: end(DELI, before).stop, mode: 'taxi' },
      { world },
      engine,
      TEST_TRANSIT,
    )
    if (!result.ok) throw new Error(result.error.code)
    expect(result.rent.length).toBeGreaterThan(0)
    expect(result.rent[0]).toMatchObject({ day: due })
  })

  it('without the transit world, only a taxi plans: a straight estimate', () => {
    const before = at(NOON)
    const request = { from: end('home', before).stop.point, to: end(DELI, before).stop }
    expect(
      takeTrip(before, { ...request, mode: 'walk' }, { world: null }, engine, TEST_TRANSIT),
    ).toEqual({
      ok: false,
      error: { code: 'NO_ROUTE_DATA' },
    })
    const taxi = takeTrip(
      before,
      { ...request, mode: 'taxi' },
      { world: null },
      engine,
      TEST_TRANSIT,
    )
    if (!taxi.ok) throw new Error(taxi.error.code)
    expect(taxi.direct).toBe(true)
    expect(taxi.route.legs).toHaveLength(1)
    expect(taxi.snapshot.player.location).toEqual({ kind: 'place', placeId: DELI })
  })
})

describe('planDirect', () => {
  it('is a straight taxi times the estimate factor, with pickup, detour, rush hour and fare', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 3000, y: 4000 }
    const noon = planDirect(from, to, NOON, TEST_TRANSIT)
    const rush = planDirect(from, to, 8 * 60, TEST_TRANSIT)
    if (!noon.ok || !rush.ok) throw new Error('unplanned')
    const pathM = 5000 * TEST_TRANSIT.taxi.estimateDetourFactor
    const drive = ((pathM * 1.3) / 1000 / 20) * 60
    expect(noon.route.durationMin).toBe(Math.ceil(5 + drive))
    expect(rush.route.durationMin).toBe(Math.ceil(5 + drive * 1.25))
    expect(noon.route.fare).toBe(Math.ceil(3 + (2 * pathM * 1.3) / 1000))
    expect(rush.route.rushHour).toBe(true)
  })

  it('is never cheaper or quicker than the routed taxi to or from any place (TRV-5)', () => {
    // Blocking the geo download must not buy a better ride: the shipped config, every place to
    // and from home. Rush hour scales both drives by the same factor, so noon covers it; the
    // estimate's factor covers the worst detour between any two spots (2.74 measured).
    const home = end('home', at(NOON)).stop.point
    let compared = 0
    for (const place of mapPlaces()) {
      const point = end(place.id, at(NOON)).stop.point
      for (const [from, to] of [
        [home, point],
        [point, home],
      ] as const) {
        const routed = planTrip(from, to, 'taxi', {
          config: transitConfig,
          minuteOfDay: NOON,
          world,
        })
        // Every place is reachable by the routed taxi, so the estimate reaches nothing it refuses.
        expect(routed.ok, place.id).toBe(true)
        const direct = planDirect(from, to, NOON, transitConfig)
        if (!routed.ok || !direct.ok) continue
        compared++
        expect(direct.route.fare, place.id).toBeGreaterThanOrEqual(routed.route.fare)
        expect(direct.route.durationMin, place.id).toBeGreaterThanOrEqual(routed.route.durationMin)
      }
    }
    expect(compared).toBe(mapPlaces().length * 2)
  })
})

describe('tripOptions (the "Get there" rows)', () => {
  it('lists every mode with what takeTrip would charge and move, or why not', () => {
    const before = at(NOON, 2)
    const from = end('home', before).stop.point
    const to = end(DELI, before).stop
    const options = tripOptions(before, from, to, { world }, engine, TEST_TRANSIT)
    expect(options.map((option) => option.mode)).toEqual(['walk', 'subway', 'taxi'])
    for (const option of options) {
      const taken = takeTrip(
        before,
        { from, to, mode: option.mode },
        { world },
        engine,
        TEST_TRANSIT,
      )
      if (option.block === null) {
        if (!taken.ok) throw new Error(taken.error.code)
        expect(taken.durationMin, option.mode).toBe(option.durationMin)
      } else {
        expect(taken, option.mode).toEqual({ ok: false, error: option.block })
      }
    }
    // $2 pays no taxi.
    expect(options.find((option) => option.mode === 'taxi')?.block).toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    })
  })

  it('blocks every mode where the player already is', () => {
    const before = atPlace(at(NOON), DELI)
    const to = end(DELI, before)
    const options = tripOptions(before, to.stop.point, to.stop, { world }, engine, TEST_TRANSIT)
    expect(options.every((option) => option.block?.code === 'ALREADY_HERE')).toBe(true)
  })

  it('without the world, walk and subway say routes are loading and the taxi estimate stays', () => {
    const before = at(NOON)
    const options = tripOptions(
      before,
      end('home', before).stop.point,
      end(DELI, before).stop,
      { world: null },
      engine,
      TEST_TRANSIT,
    )
    expect(options.map((option) => option.block?.code ?? null)).toEqual([
      'NO_ROUTE_DATA',
      'NO_ROUTE_DATA',
      null,
    ])
  })
})

describe('travel returns rent (BUG-1 pattern)', () => {
  it('a trip across a rent day reports the rent event', () => {
    const base = at(NOON, 1000)
    const due = nextRentDueDay(base.clock.minute, engine)
    const before: GameSnapshot = { ...base, clock: { minute: (due - 1) * DAY - 2, remainderMs: 0 } }
    const home = end('home', before).stop.point
    const result = travel(
      before,
      { from: home, to: end(DELI, before).stop.point, mode: 'taxi' },
      { world, rng: { next: () => 0.999, state: 0 } },
      engine,
      TEST_TRANSIT,
    )
    if (!result.ok) throw new Error(result.error.code)
    expect(calendar(result.snapshot.clock.minute, engine).day).toBeGreaterThanOrEqual(due)
    expect(result.rent.length).toBeGreaterThan(0)
  })
})
