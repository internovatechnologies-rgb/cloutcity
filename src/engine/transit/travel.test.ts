import { describe, expect, it } from 'vitest'
import { engineConfig, type EngineConfig } from '../config'
import { initialSnapshot, type GameSnapshot } from '../game'
import { createRng, type Rng } from '../rng'
import type { TransitConfig } from './config'
import { planTrip, type Route } from './plan'
import { EIGHT_AM, NOON, PLACES, TEST_TRANSIT, allLandWorld, testWorld } from './test-fixtures'
import {
  MTA_DELAY_EVENT,
  rollSubwayDelay,
  travel,
  travelActionDef,
  type TravelRequest,
  type TravelResult,
} from './travel'

/** Fixed stats numbers so these tests do not move when balance.json is tuned. */
const engine: EngineConfig = {
  ...engineConfig,
  startCash: 150,
  stats: {
    max: 100,
    start: { energy: 100, hunger: 80, mood: 70 },
    decayPerGameHour: { energy: 3, hunger: 5, mood: 2 },
    atZero: {
      energy: { extraDecayPerGameHour: { mood: 3 }, durationMultiplier: 1.5 },
      hunger: { extraDecayPerGameHour: { energy: 3, mood: 4 }, durationMultiplier: 1 },
      mood: { extraDecayPerGameHour: {}, durationMultiplier: 1.25 },
    },
  },
}

const world = testWorld()
/** A source that returns whatever `draw` gives (state is not used by travel). */
const source = (draw: () => number): Rng => ({ next: draw, state: 0 })
const never = source(() => 0.999)
const always = source(() => 0)

function at(minuteOfDay: number, cash = 150): GameSnapshot {
  const base = initialSnapshot(engine)
  return {
    clock: { minute: 24 * 60 + minuteOfDay, remainderMs: 0 },
    player: { ...base.player, cash },
  }
}

const coneyToTimesSq: TravelRequest = {
  from: PLACES.coneyIsland,
  to: PLACES.timesSquare,
  mode: 'subway',
}

const manhattanWalk: TravelRequest = {
  from: PLACES.timesSquare,
  to: PLACES.unionSquare,
  mode: 'walk',
}

function plannedWalk(): Route {
  const result = planTrip(manhattanWalk.from, manhattanWalk.to, 'walk', {
    config: TEST_TRANSIT,
    minuteOfDay: NOON,
    world,
  })
  if (!result.ok) throw new Error(result.error.code)
  return result.route
}

function ok(result: TravelResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`)
  return result
}

function planned(minuteOfDay: number, mode: TravelRequest['mode'] = 'subway'): Route {
  const result = planTrip(coneyToTimesSq.from, coneyToTimesSq.to, mode, {
    config: TEST_TRANSIT,
    minuteOfDay,
    world,
  })
  if (!result.ok) throw new Error(result.error.code)
  return result.route
}

describe('travel action', () => {
  it('fast-forwards the clock by the trip, charges the fare and drains walking energy', () => {
    const before = at(NOON)
    const result = ok(travel(before, coneyToTimesSq, { world, rng: never }, engine, TEST_TRANSIT))
    const route = planned(NOON)
    expect(result.durationMin).toBe(route.durationMin)
    expect(result.snapshot.clock.minute).toBe(before.clock.minute + route.durationMin)
    expect(result.snapshot.player.cash).toBe(150 - 3)
    expect(result.route.legs).toEqual(route.legs)
    expect(result.events).toEqual([])
    const hours = Math.floor((NOON + route.durationMin) / 60) - Math.floor(NOON / 60)
    const walkedEnergy = Math.round((route.walkedM / 1000) * TEST_TRANSIT.walk.energyPerKm)
    expect(result.snapshot.player.stats.energy).toBe(100 - 3 * hours - walkedEnergy)
    expect(result.snapshot.player.stats.mood).toBe(70 - 2 * hours)
  })

  it('charges the taxi fare and walks for free', () => {
    const taxi = ok(
      travel(
        at(NOON),
        { ...coneyToTimesSq, mode: 'taxi' },
        { world, rng: never },
        engine,
        TEST_TRANSIT,
      ),
    )
    expect(taxi.snapshot.player.cash).toBe(150 - planned(NOON, 'taxi').fare)
    const walk = ok(travel(at(NOON, 0), manhattanWalk, { world, rng: never }, engine, TEST_TRANSIT))
    expect(walk.snapshot.player.cash).toBe(0)
  })

  it('refuses a subway or taxi trip the player cannot pay for, changing nothing', () => {
    const broke = at(NOON, 2)
    expect(travel(broke, coneyToTimesSq, { world, rng: never }, engine, TEST_TRANSIT)).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: 3, available: 2 },
    })
    const taxi = travel(
      at(NOON, 20),
      { ...coneyToTimesSq, mode: 'taxi' },
      { world, rng: never },
      engine,
      TEST_TRANSIT,
    )
    expect(taxi).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: planned(NOON, 'taxi').fare, available: 20 },
    })
  })

  it('does not draw from the random source for a refused trip', () => {
    let draws = 0
    const counting = source(() => {
      draws++
      return 0.5
    })
    travel(at(NOON, 0), coneyToTimesSq, { world, rng: counting }, engine, TEST_TRANSIT)
    expect(draws).toBe(0)
  })

  it('passes planning errors through', () => {
    const result = travel(
      at(NOON),
      { from: PLACES.stGeorge, to: PLACES.timesSquare, mode: 'subway' },
      { world, rng: never },
      engine,
      TEST_TRANSIT,
    )
    expect(result).toEqual({ ok: false, error: { code: 'NO_SUBWAY_ROUTE' } })
  })

  it('lets an exhausted player walk home (energy is not an up-front cost)', () => {
    const exhausted: GameSnapshot = {
      ...at(NOON),
      player: { ...at(NOON).player, cash: 0, stats: { energy: 0, hunger: 80, mood: 70 } },
    }
    const result = ok(travel(exhausted, manhattanWalk, { world, rng: never }, engine, TEST_TRANSIT))
    // The at-zero slowdown (energy 0: 1.5x) applies to travel like any action.
    expect(result.durationMin).toBe(Math.ceil(plannedWalk().durationMin * 1.5))
    expect(result.route.durationMin).toBe(result.durationMin)
  })
})

describe('rush hour on the subway', () => {
  it('drains mood at 8:00 but not at 12:00', () => {
    const rush = travelActionDef(planned(EIGHT_AM), false, engine, TEST_TRANSIT)
    const noon = travelActionDef(planned(NOON), false, engine, TEST_TRANSIT)
    expect(rush.statEffects.mood).toBe(-TEST_TRANSIT.rushHour.subwayMoodDrain)
    expect(noon.statEffects.mood).toBeUndefined()
    expect(rush.durationMin).toBeGreaterThan(noon.durationMin)
  })

  it('lands the drain on the player at arrival', () => {
    const rush = ok(
      travel(at(EIGHT_AM), coneyToTimesSq, { world, rng: never }, engine, TEST_TRANSIT),
    )
    const hours = Math.floor((EIGHT_AM + rush.durationMin) / 60) - Math.floor(EIGHT_AM / 60)
    expect(rush.snapshot.player.stats.mood).toBe(
      70 - 2 * hours - TEST_TRANSIT.rushHour.subwayMoodDrain,
    )
  })

  it('does not drain mood on a taxi in rush hour', () => {
    const taxi = travelActionDef(planned(EIGHT_AM, 'taxi'), false, engine, TEST_TRANSIT)
    expect(taxi.statEffects.mood).toBeUndefined()
  })
})

describe('MTA delay hook', () => {
  const delays: TransitConfig = {
    ...TEST_TRANSIT,
    delay: { probability: 0.5, rushProbability: 0.9, minutes: { min: 5, max: 20 }, moodDrain: 3 },
  }

  it('replays exactly with the same seed', () => {
    const run = () =>
      Array.from({ length: 30 }, (_, i) => i).reduce<{ snapshots: unknown[]; rng: Rng }>(
        (acc) => {
          const result = travel(at(NOON), coneyToTimesSq, { world, rng: acc.rng }, engine, delays)
          acc.snapshots.push(result)
          return acc
        },
        { snapshots: [], rng: createRng(2026) },
      ).snapshots
    const first = run()
    expect(run()).toEqual(first)
    const delayed = first.filter(
      (r) => (r as TravelResult).ok && (r as { events: unknown[] }).events.length > 0,
    )
    expect(delayed.length).toBeGreaterThan(0)
    expect(delayed.length).toBeLessThan(30)
  })

  it('emits a typed event and adds the delay to the first train', () => {
    const route = planned(NOON)
    const rolls = [0.1, 0.5]
    const rng = source(() => rolls.shift() ?? 0)
    const { route: delayedRoute, event } = rollSubwayDelay(route, rng, delays)
    // 0.5 of a 5..20 range: 5 + floor(0.5 x 16) = 13 minutes.
    expect(event).toEqual({ id: MTA_DELAY_EVENT, lineId: expect.any(String), extraMin: 13 })
    expect(event?.id).toBe('transit.mta-delay')
    expect(delayedRoute.durationMin).toBe(route.durationMin + 13)
    const firstTrain = (r: Route) => r.legs.find((leg) => leg.mode === 'subway')
    const before = firstTrain(route)
    const after = firstTrain(delayedRoute)
    if (before?.mode !== 'subway' || after?.mode !== 'subway') throw new Error('no train')
    expect(event?.lineId).toBe(before.lineId)
    expect(after.waitMin).toBe(before.waitMin + 13)
  })

  it('uses the rush-hour probability in rush hour', () => {
    const roll = source(() => 0.7)
    expect(rollSubwayDelay(planned(NOON), roll, delays).event).toBeUndefined()
    expect(rollSubwayDelay(planned(EIGHT_AM), roll, delays).event).toBeDefined()
  })

  it('never delays walks or taxis, and drains mood when it hits', () => {
    expect(rollSubwayDelay(planned(NOON, 'taxi'), always, delays).event).toBeUndefined()
    expect(rollSubwayDelay(plannedWalk(), always, delays).event).toBeUndefined()
    const result = ok(travel(at(NOON), coneyToTimesSq, { world, rng: always }, engine, delays))
    expect(result.events).toHaveLength(1)
    expect(result.durationMin).toBe(planned(NOON).durationMin + delays.delay.minutes.min)
    expect(travelActionDef(result.route, true, engine, delays).statEffects.mood).toBe(-3)
  })
})

describe('trip length limit', () => {
  it('refuses a trip longer than any one action may be with TRIP_TOO_LONG, drawing nothing', () => {
    const far: TravelRequest = { from: { x: 0, y: 0 }, to: { x: 90_000, y: 0 }, mode: 'walk' }
    let draws = 0
    const result = travel(
      at(NOON),
      far,
      {
        world: allLandWorld(),
        rng: source(() => {
          draws++
          return 0
        }),
      },
      engine,
      TEST_TRANSIT,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatchObject({ code: 'TRIP_TOO_LONG', maxMin: 1440 })
    expect(draws).toBe(0)
  })
})
