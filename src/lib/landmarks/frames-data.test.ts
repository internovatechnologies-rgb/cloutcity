/**
 * The committed landmark frames (data/landmarks/frames.derived.json, from LION) agree with the
 * rest of the world data: bridges land in the boroughs they span and cross water, run along
 * S08's taxi crossings, Midtown buildings sit on the Manhattan grid, and every anchor matches
 * its landmark.
 */
import { describe, expect, it } from 'vitest'
import framesJson from '@data/landmarks/frames.derived.json'
import modelsJson from '@data/landmarks/models.json'
import { balance } from '@/lib/data/config'
import { landmarks } from '@/lib/data/content'
import { land } from '@/lib/data/geo'
import { LandmarkModelsFileSchema } from '@/lib/data/schemas/landmarkModels'
import { LandmarkFramesFileSchema } from '@/lib/data/schemas/world'
import { areaAt, prepareAreas } from '@/lib/geo/lookup'
import { distanceM, project, type LocalPoint } from '@/lib/geo/projection'
import { modelTopM } from './metrics'

const frames = LandmarkFramesFileSchema.parse(framesJson).landmarks
const models = LandmarkModelsFileSchema.parse(modelsJson).models
const boroughs = prepareAreas(land.boroughs)
const placeOf = (id: string) => {
  const place = landmarks.find((l) => l.id === id)
  if (place === undefined) throw new Error(`no landmark ${id}`)
  return place
}
const bridges = frames.filter((f) => f.ends !== undefined)
const others = frames.filter((f) => f.ends === undefined)

/** Smallest angle between two bearings, in degrees. */
const angleBetween = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360)
  return Math.min(d, 360 - d)
}
const bearing = (from: LocalPoint, to: LocalPoint) =>
  ((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI + 360) % 360

describe('landmark frames', () => {
  it('one frame per model, sorted by id, derived from LION and the borough boundaries', () => {
    expect(frames.map((f) => f.id)).toEqual(models.map((m) => m.id).sort())
    expect(framesJson.derived).toBe(true)
    expect(framesJson.sources).toContain('dcp-borough-boundaries')
    expect(bridges.map((f) => f.id)).toEqual([
      'brooklyn-bridge',
      'manhattan-bridge',
      'queensboro-bridge',
    ])
  })

  it.each(bridges.map((f) => [f.id, f] as const))(
    '%s: ends on land in exactly the boroughs it spans, midpoint over water',
    (id, frame) => {
      const spans = placeOf(id).spans ?? []
      const [first, second] = frame.ends ?? []
      if (first === undefined || second === undefined) throw new Error('no ends')
      expect([areaAt(first, boroughs), areaAt(second, boroughs)]).toEqual(spans)
      const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
      expect(areaAt(mid, boroughs)).toBeUndefined()
      expect(frame.spanM).toBeCloseTo(distanceM(first, second), -0.5)
    },
  )

  it.each(bridges.map((f) => [f.id, f] as const))(
    '%s: heading within 10° of the S08 crossing a→b bearing',
    (id, frame) => {
      const crossing = balance.transit.crossings.find((c) => c.id === id)
      if (crossing === undefined) throw new Error(`no crossing ${id}`)
      const expected = bearing(project(crossing.a), project(crossing.b))
      expect(angleBetween(frame.headingDeg, expected)).toBeLessThanOrEqual(10)
    },
  )

  it.each(bridges.map((f) => [f.id, f] as const))(
    '%s: anchor within 60 m of the LION axis centre',
    (_id, frame) => {
      if (!('axisCentre' in frame.lion)) throw new Error('no axis centre')
      expect(distanceM(frame.anchor, frame.lion.axisCentre)).toBeLessThanOrEqual(60)
    },
  )

  it('suspension towers stand in the water', () => {
    for (const model of models) {
      if (model.archetype !== 'suspensionBridge') continue
      const frame = frames.find((f) => f.id === model.id)
      const [first, second] = frame?.ends ?? []
      if (frame === undefined || first === undefined || second === undefined) continue
      const ux = (second.x - first.x) / (frame.spanM ?? 1)
      const uy = (second.y - first.y) / (frame.spanM ?? 1)
      for (const s of model.params.towers.offsetsM) {
        const tower = { x: frame.anchor.x + s * ux, y: frame.anchor.y + s * uy }
        expect(areaAt(tower, boroughs), `${model.id} tower at ${s} m`).toBeUndefined()
      }
    }
  })

  it.each(['deco-spire', 'midtown-terminal', 'penn-station'])(
    '%s sits on the Manhattan grid (about 29°, ±3°)',
    (id) => {
      const frame = frames.find((f) => f.id === id)
      const offGrid = Math.min(
        ...[0, 90, 180, 270].map((turn) => angleBetween(frame?.headingDeg ?? 0, 29 + turn)),
      )
      expect(offGrid).toBeLessThanOrEqual(3)
    },
  )

  it.each(others.map((f) => [f.id, f] as const))(
    '%s: anchored on its location (≤ 1 m), fronting street within 80 m',
    (id, frame) => {
      expect(distanceM(frame.anchor, project(placeOf(id).location))).toBeLessThanOrEqual(1)
      if (!('frontM' in frame.lion)) throw new Error('no front distance')
      expect(frame.lion.frontM).toBeLessThanOrEqual(80)
      expect(frame.base).toBe('land')
    },
  )

  it('every pin lift is its model’s top, and every exclusion sits on the anchor', () => {
    for (const frame of frames) {
      const model = models.find((m) => m.id === frame.id)
      if (model === undefined) throw new Error(`no model ${frame.id}`)
      expect(frame.pinLiftM).toBeCloseTo(modelTopM(model), 1)
      expect([frame.exclusion.x, frame.exclusion.y]).toEqual([frame.anchor.x, frame.anchor.y])
      // S04d's angle: counter-clockwise from east; the heading: clockwise from north.
      expect(angleBetween(frame.exclusion.angleDeg, 90 - frame.headingDeg)).toBeLessThan(0.11)
      if (frame.spanM !== undefined) {
        expect(frame.exclusion.halfLengthM).toBeGreaterThan(frame.spanM / 2)
      }
    }
  })
})
