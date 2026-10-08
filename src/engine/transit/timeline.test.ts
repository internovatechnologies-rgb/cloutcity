import { describe, expect, it } from 'vitest'
import { distanceToPolyline } from '@/lib/geo/polygon'
import { distanceM } from '@/lib/geo/projection'
import { planTrip, type Route } from './plan'
import { NOON, PLACES, TEST_TRANSIT, testWorld } from './test-fixtures'
import { TimelineError, createTimeline } from './timeline'

const animation = TEST_TRANSIT.animation
const motion = { reducedMotion: false, animation }

function plan(from = PLACES.coneyIsland, to = PLACES.timesSquare, mode: Route['mode'] = 'subway') {
  const result = planTrip(from, to, mode, {
    config: TEST_TRANSIT,
    minuteOfDay: NOON,
    world: testWorld(),
  })
  if (!result.ok) throw new Error(result.error.code)
  return result.route
}

describe('travel animation timeline', () => {
  it('never runs longer than the configured maximum', () => {
    const route = plan()
    expect(route.durationMin * animation.msPerGameMinute).toBeGreaterThan(animation.maxMs)
    const timeline = createTimeline(route, motion)
    expect(timeline.durationMs).toBe(animation.maxMs)
    expect(timeline.legs[timeline.legs.length - 1]?.endMs).toBe(animation.maxMs)
  })

  it('plays a short trip in proportion to its game minutes', () => {
    const route = plan(PLACES.timesSquare, PLACES.bryantPark, 'walk')
    const timeline = createTimeline(route, motion)
    expect(timeline.durationMs).toBe(route.durationMin * animation.msPerGameMinute)
    expect(timeline.durationMs).toBeLessThan(animation.maxMs)
  })

  it('gives the legs back-to-back spans covering the whole animation', () => {
    const route = plan()
    const timeline = createTimeline(route, motion)
    expect(timeline.legs).toHaveLength(route.legs.length)
    expect(timeline.legs[0]?.startMs).toBe(0)
    for (let i = 1; i < timeline.legs.length; i++) {
      expect(timeline.legs[i]?.startMs).toBe(timeline.legs[i - 1]?.endMs)
    }
  })

  it('starts at the origin, ends at the destination and is clamped outside its span', () => {
    const route = plan()
    const timeline = createTimeline(route, motion)
    expect(distanceM(timeline.frameAt(0).point, route.from)).toBeLessThan(1e-6)
    expect(timeline.frameAt(-100).point).toEqual(timeline.frameAt(0).point)
    expect(timeline.frameAt(0).done).toBe(false)
    const end = timeline.frameAt(timeline.durationMs)
    expect(end).toMatchObject({ point: route.to, done: true, gameMinutes: route.durationMin })
    expect(timeline.frameAt(timeline.durationMs + 5000)).toEqual(end)
  })

  it('fast-forwards the clock monotonically and moves the avatar along each leg', () => {
    const route = plan()
    const timeline = createTimeline(route, motion)
    let lastMinutes = -1
    for (let t = 0; t <= timeline.durationMs; t += 25) {
      const frame = timeline.frameAt(t)
      expect(frame.gameMinutes).toBeGreaterThanOrEqual(lastMinutes)
      expect(frame.gameMinutes).toBeLessThanOrEqual(route.durationMin)
      lastMinutes = frame.gameMinutes
      const leg = route.legs[frame.legIndex]
      if (leg === undefined) throw new Error('leg out of range')
      expect(frame.mode).toBe(leg.mode)
      // Subway frames ride the line path (its ribbon), never cut across.
      expect(distanceToPolyline(frame.point, leg.polyline)).toBeLessThan(1e-6)
    }
  })

  it('holds at the platform for the wait, then rides', () => {
    const route = plan()
    const timeline = createTimeline(route, motion)
    const index = route.legs.findIndex((leg) => leg.mode === 'subway')
    const leg = route.legs[index]
    const span = timeline.legs[index]
    if (leg?.mode !== 'subway' || span === undefined) throw new Error('no subway leg')
    const holdMs = (span.endMs - span.startMs) * (leg.waitMin / leg.minutes)
    const waiting = timeline.frameAt(span.startMs + holdMs / 2)
    expect(waiting.waiting).toBe(true)
    expect(distanceM(waiting.point, leg.polyline[0] ?? leg.from)).toBeLessThan(1e-6)
    expect(timeline.frameAt(span.startMs + holdMs + 1).waiting).toBe(false)
  })

  it('cuts straight to the arrival with reduced motion', () => {
    const route = plan()
    const timeline = createTimeline(route, { reducedMotion: true, animation })
    expect(timeline.durationMs).toBe(0)
    expect(timeline.frameAt(0)).toEqual({
      point: route.to,
      legIndex: route.legs.length - 1,
      mode: 'walk',
      waiting: false,
      gameMinutes: route.durationMin,
      done: true,
    })
  })

  it('cuts when the configured maximum is zero', () => {
    const timeline = createTimeline(plan(), {
      reducedMotion: false,
      animation: { ...animation, maxMs: 0 },
    })
    expect(timeline.durationMs).toBe(0)
    expect(timeline.frameAt(0).done).toBe(true)
  })

  it('rejects a route with a non-finite or negative duration', () => {
    const route = plan()
    for (const durationMin of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => createTimeline({ ...route, durationMin }, motion)).toThrow(TimelineError)
    }
    const badLeg = {
      ...route,
      legs: [{ ...route.legs[0]!, minutes: Number.NaN }, ...route.legs.slice(1)],
    }
    expect(() => createTimeline(badLeg, motion)).toThrow(TimelineError)
  })
})
