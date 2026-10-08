import { describe, expect, it } from 'vitest'
import { decodePath, decodeRing, encodePath, encodeRing } from './codec'
import { areaAt, nearestArea, nearestStation, prepareAreas } from './lookup'
import {
  distanceToPolyline,
  interiorPoint,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  signedArea,
  type Polygon,
} from './polygon'

const square = (x: number, y: number, size: number) => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
]

describe('codec', () => {
  it('round-trips rings and paths through delta encoding', () => {
    const ring = [
      { x: -5, y: 10 },
      { x: 100, y: 10 },
      { x: 100, y: -3000 },
    ]
    expect(encodeRing(ring)).toEqual([-5, 10, 105, 0, 0, -3010])
    expect(decodeRing(encodeRing(ring))).toEqual(ring)
    expect(decodePath(encodePath(ring))).toEqual(ring)
  })

  it('rejects fractional coordinates and odd-length input', () => {
    expect(() => encodeRing([{ x: 0.5, y: 0 }])).toThrow(/integer/)
    expect(() => decodeRing([1, 2, 3])).toThrow(/odd/)
  })
})

describe('polygon', () => {
  const outer = square(0, 0, 100)
  const hole = [...square(25, 25, 50)].reverse()
  const donut: Polygon = [outer, hole]

  it('signed area is positive counter-clockwise, and holes subtract', () => {
    expect(signedArea(outer)).toBe(10_000)
    expect(signedArea(hole)).toBe(-2500)
    expect(polygonArea(donut)).toBe(7500)
  })

  it('point in polygon honours holes (even-odd) and the bbox prefilter', () => {
    expect(pointInPolygon({ x: 10, y: 10 }, donut)).toBe(true)
    expect(pointInPolygon({ x: 50, y: 50 }, donut)).toBe(false)
    expect(pointInPolygon({ x: 150, y: 50 }, donut)).toBe(false)
    expect(pointInPolygon({ x: -1, y: 50 }, donut)).toBe(false)
    // An island inside the hole is inside again.
    const island: Polygon = [outer, hole, square(45, 45, 10)]
    expect(pointInPolygon({ x: 50, y: 50 }, island)).toBe(true)
  })

  it('distance to a polyline is the distance to its nearest segment', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]
    expect(distanceToPolyline({ x: 50, y: 7 }, path)).toBe(7)
    expect(distanceToPolyline({ x: 103, y: 104 }, path)).toBe(5)
    expect(distanceToPolyline({ x: 3, y: 4 }, [{ x: 0, y: 0 }])).toBe(5)
    expect(distanceToPolyline({ x: 0, y: 0 }, [])).toBe(Infinity)
  })

  it('interior point is the rounded centroid when that lies inside', () => {
    expect(polygonCentroid([outer])).toEqual({ x: 50, y: 50 })
    expect(interiorPoint([outer])).toEqual({ x: 50, y: 50 })
  })

  it('interior point falls back to a scanline when the centroid is in a hole or a notch', () => {
    const point = interiorPoint(donut)
    expect(pointInPolygon(point, donut)).toBe(true)
    expect(Number.isInteger(point.x) && Number.isInteger(point.y)).toBe(true)
    const cShape: Polygon = [
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 90 },
        { x: 100, y: 90 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    ]
    expect(pointInPolygon(interiorPoint(cShape), cShape)).toBe(true)
  })
})

describe('lookup', () => {
  const areas = prepareAreas([
    { id: 'west', polygons: [[encodeRing(square(0, 0, 100))]] },
    { id: 'east', polygons: [[encodeRing(square(100, 0, 100))]] },
  ])

  it('finds the containing area, or none in the gap', () => {
    expect(areaAt({ x: 50, y: 50 }, areas)).toBe('west')
    expect(areaAt({ x: 150, y: 50 }, areas)).toBe('east')
    expect(areaAt({ x: 50, y: 150 }, areas)).toBeUndefined()
  })

  it('nearest area reports distance 0 inside and the boundary distance outside', () => {
    expect(nearestArea({ x: 50, y: 50 }, areas)).toEqual({ id: 'west', distanceM: 0 })
    expect(nearestArea({ x: 150, y: 130 }, areas)).toEqual({ id: 'east', distanceM: 30 })
  })

  it('nearest station picks the closest, ties to the earlier one', () => {
    const stations = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 0 },
      { id: 'c', x: -10, y: 0 },
    ]
    expect(nearestStation({ x: 8, y: 0 }, stations)?.station.id).toBe('b')
    expect(nearestStation({ x: 5, y: 0 }, stations)?.station.id).toBe('a')
    expect(nearestStation({ x: 0, y: 0 }, [])).toBeUndefined()
  })
})

/** Winding-number reference for simple rings (non-zero rule), on points off every edge. */
function windingInside(point: { x: number; y: number }, polygon: Polygon): boolean {
  let winding = 0
  for (const ring of polygon) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      if (a === undefined || b === undefined) continue
      const cross = (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y)
      if (a.y <= point.y) {
        if (b.y > point.y && cross > 0) winding++
      } else if (b.y <= point.y && cross < 0) winding--
    }
  }
  return winding !== 0
}

const onAnyEdge = (point: { x: number; y: number }, polygon: Polygon) =>
  polygon.some((ring) =>
    ring.some((a, i) => {
      const b = ring[(i + 1) % ring.length]
      return b !== undefined && distanceToPolyline(point, [a, b]) === 0
    }),
  )

describe('point in polygon on integer grids (the committed data is whole metres)', () => {
  // A comb: horizontal edges and vertices sit exactly on the scanlines of grid points, and
  // spikes put local minima and maxima (V and Λ vertices) on them too.
  const comb: Polygon = [
    [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 17, y: 4 },
      { x: 14, y: 10 },
      { x: 11, y: 4 },
      { x: 8, y: 10 },
      { x: 8, y: 6 },
      { x: 4, y: 6 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ],
    // A diamond hole (clockwise) whose left and right vertices are on the y = 2 scanline.
    [
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 2 },
      { x: 3, y: 1 },
    ],
  ]

  it('agrees with a winding-number reference at every grid point off the edges', () => {
    let checked = 0
    for (let x = -2; x <= 22; x++) {
      for (let y = -2; y <= 12; y++) {
        const point = { x, y }
        if (onAnyEdge(point, comb)) continue
        expect(pointInPolygon(point, comb), `${x},${y}`).toBe(windingInside(point, comb))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(250)
  })

  it('rays through a vertex count once (pass-through) or twice (tip)', () => {
    // y = 4 passes through the two V tips at (11,4) and (17,4): inside the comb on both sides.
    expect(pointInPolygon({ x: 1, y: 4 }, comb)).toBe(true)
    expect(pointInPolygon({ x: 10, y: 4 }, comb)).toBe(true)
    // y = 2 passes through the hole's side vertices.
    expect(pointInPolygon({ x: 1, y: 2 }, comb)).toBe(true)
    expect(pointInPolygon({ x: 5, y: 2 }, comb)).toBe(true)
    // Between the teeth, above the V tips, is outside.
    expect(pointInPolygon({ x: 11, y: 8 }, comb)).toBe(false)
    expect(pointInPolygon({ x: 6, y: 8 }, comb)).toBe(false)
  })

  it('points on an edge give a stable answer and never throw', () => {
    for (const point of [
      { x: 10, y: 0 },
      { x: 0, y: 5 },
      { x: 6, y: 6 },
      { x: 3, y: 1 },
    ]) {
      expect(typeof pointInPolygon(point, comb)).toBe('boolean')
      expect(pointInPolygon(point, comb)).toBe(pointInPolygon(point, comb))
    }
  })

  it('a degenerate ring (fewer than three points) contains nothing', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [[]])).toBe(false)
    expect(
      pointInPolygon({ x: 1, y: 0 }, [
        [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
      ]),
    ).toBe(false)
  })
})

describe('interiorPoint on awkward shapes', () => {
  const ring = (coords: number[][]) => coords.map(([x = 0, y = 0]) => ({ x, y }))
  const shapes: Record<string, Polygon> = {
    // A thin C whose centroid is in the mouth.
    'thin C': [
      ring([
        [0, 0],
        [1000, 0],
        [1000, 3],
        [3, 3],
        [3, 997],
        [1000, 997],
        [1000, 1000],
        [0, 1000],
      ]),
    ],
    // A ring (annulus) whose centroid is in the hole.
    annulus: [
      ring([
        [0, 0],
        [500, 0],
        [500, 500],
        [0, 500],
      ]),
      ring([
        [5, 5],
        [5, 495],
        [495, 495],
        [495, 5],
      ]),
    ],
    // An L of two 2 m wide arms (the thinnest with an integer point strictly inside).
    'thin L': [
      ring([
        [0, 0],
        [800, 0],
        [800, 2],
        [2, 2],
        [2, 800],
        [0, 800],
      ]),
    ],
    // A diagonal sliver: the scanlines all cross it on a slant.
    'diagonal sliver': [
      ring([
        [0, 0],
        [3, 0],
        [903, 900],
        [900, 900],
      ]),
    ],
    // A U opening down, centroid between the legs.
    'U shape': [
      ring([
        [0, 0],
        [10, 0],
        [10, 90],
        [90, 90],
        [90, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ]),
    ],
  }

  it.each(Object.entries(shapes))('%s: an integer point strictly inside', (_name, polygon) => {
    const point = interiorPoint(polygon)
    expect(Number.isInteger(point.x) && Number.isInteger(point.y)).toBe(true)
    expect(pointInPolygon(point, polygon)).toBe(true)
    expect(windingInside(point, polygon) || onAnyEdge(point, polygon)).toBe(true)
  })

  it('throws on an empty or collapsed polygon instead of inventing a point', () => {
    expect(() => interiorPoint([])).toThrow(/empty/)
    expect(() =>
      interiorPoint([
        ring([
          [0, 0],
          [1, 1],
        ]),
      ]),
    ).toThrow(/empty/)
  })
})
