import { describe, expect, it } from 'vitest'
import { InstancedMesh, MeshBasicMaterial, Vector3, type BufferGeometry } from 'three'
import { scene as sceneConfig } from '@/lib/data/config'
import { land, parks, subway, water } from '@/lib/data/geo'
import { decodeRing, encodePath, encodeRing } from '@/lib/geo/codec'
import { polygonArea } from '@/lib/geo/polygon'
import { log } from '@/lib/log'
import { buildLandGeometry, buildWaterGeometry, landTopY } from './buildLand'
import { atlasLayout, buildLabelGeometry, cellUv, terminalChips } from './buildLabels'
import { buildParkGeometry, polygonsOfKind } from './buildParks'
import {
  buildStationGeometry,
  stationPositions,
  stationRadius,
  writeStationMatrices,
} from './buildStations'
import { buildSubwayGeometry, lineColors, subwaySegments } from './buildSubway'
import { toLocal, toScene } from './coords'

/** Area of the triangles whose three vertices all lie at height `y`, projected on the ground. */
function areaAtHeight(geometry: BufferGeometry, y: number): number {
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const count = index ? index.count : position.count
  const at = (i: number) => {
    const v = index ? index.getX(i) : i
    return new Vector3(position.getX(v), position.getY(v), position.getZ(v))
  }
  let area = 0
  for (let i = 0; i < count; i += 3) {
    const [a, b, c] = [at(i), at(i + 1), at(i + 2)]
    if ([a, b, c].some((p) => Math.abs(p.y - y) > 1e-6)) continue
    area += Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2
  }
  return area
}

/** True when every triangle at height `y` faces up (+y). */
function upFacing(geometry: BufferGeometry, y: number): boolean {
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const count = index ? index.count : position.count
  const at = (i: number) => {
    const v = index ? index.getX(i) : i
    return new Vector3(position.getX(v), position.getY(v), position.getZ(v))
  }
  for (let i = 0; i < count; i += 3) {
    const [a, b, c] = [at(i), at(i + 1), at(i + 2)]
    if ([a, b, c].some((p) => Math.abs(p.y - y) > 1e-6)) continue
    const normal = new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a))
    if (normal.y <= 0) return false
  }
  return true
}

const heights = { heightM: 60, baseM: 20 }
const square = (x: number, y: number, size: number, ccw = true) => {
  const ring = [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ]
  return ccw ? ring : ring.reverse()
}

describe('coords', () => {
  it('maps local metres to scene axes: x east, y up, z = -north', () => {
    expect(toScene({ x: 10, y: 20 }, 5).toArray()).toEqual([10, 5, -20])
    expect(toLocal({ x: 10, z: -20 })).toEqual({ x: 10, y: 20 })
  })

  it('lays extruded land with the same axes: north of the origin is -z', () => {
    const geometry = buildLandGeometry([[encodeRing(square(0, 1000, 100))]], heights)
    geometry.computeBoundingBox()
    const box = geometry.boundingBox
    expect(box?.min.x).toBeCloseTo(0)
    expect(box?.max.x).toBeCloseTo(100)
    expect(box?.min.z).toBeCloseTo(-1100)
    expect(box?.max.z).toBeCloseTo(-1000)
    expect(box?.min.y).toBeCloseTo(-heights.baseM)
    expect(box?.max.y).toBeCloseTo(landTopY(heights))
  })
})

describe('buildLandGeometry', () => {
  it('triangulates a polygon with a hole: the top area equals polygonArea, facing up', () => {
    const outer = square(0, 0, 1000)
    const hole = square(300, 300, 200, false)
    const geometry = buildLandGeometry([[encodeRing(outer), encodeRing(hole)]], heights)
    const top = landTopY(heights)
    expect(areaAtHeight(geometry, top)).toBeCloseTo(polygonArea([outer, hole]), 3)
    expect(upFacing(geometry, top)).toBe(true)
    expect(geometry.getAttribute('uv')).toBeUndefined()
    expect(geometry.groups).toEqual([])
  })

  it('accepts clockwise outer rings too', () => {
    const geometry = buildLandGeometry([[encodeRing(square(0, 0, 100, false))]], heights)
    expect(areaAtHeight(geometry, landTopY(heights))).toBeCloseTo(10_000, 3)
    expect(upFacing(geometry, landTopY(heights))).toBe(true)
  })

  it('triangulates every real borough to within 0.5% of its polygon area', () => {
    const top = landTopY(heights)
    let triangles = 0
    for (const borough of land.boroughs) {
      const geometry = buildLandGeometry(borough.polygons, heights)
      triangles += geometry.getAttribute('position').count / 3
      const expected = borough.polygons
        .map((polygon) => polygonArea(polygon.map(decodeRing)))
        .reduce((sum, area) => sum + area, 0)
      const actual = areaAtHeight(geometry, top)
      const error = Math.abs(actual - expected) / expected
      if (error > 0.0001) {
        log.info('land triangulation area differs from polygon area', {
          borough: borough.id,
          error,
        })
      }
      expect(error, borough.id).toBeLessThan(0.005)
    }
    // Default-view budget guard: all of the land stays well under the mid tier's triangles.
    expect(triangles).toBeLessThan(150_000)
  })
})

describe('buildWaterGeometry', () => {
  it('covers the sea polygon plus the margin at y = 0', () => {
    const geometry = buildWaterGeometry(water.sea, 500)
    geometry.computeBoundingBox()
    const sea = decodeRing(water.sea[0] ?? [])
    const minX = Math.min(...sea.map((p) => p.x))
    const maxY = Math.max(...sea.map((p) => p.y))
    expect(geometry.boundingBox?.min.x).toBeCloseTo(minX - 500)
    expect(geometry.boundingBox?.min.z).toBeCloseTo(-maxY - 500)
    expect(geometry.boundingBox?.max.y).toBeCloseTo(0)
  })
})

describe('buildParkGeometry', () => {
  it('splits the real parks by kind and keeps every polygon', () => {
    const parkPolygons = polygonsOfKind(parks.parks, 'park')
    const cemeteries = polygonsOfKind(parks.parks, 'cemetery')
    expect(parkPolygons.length + cemeteries.length).toBe(
      parks.parks.reduce((n, park) => n + park.polygons.length, 0),
    )
    const y = 41
    const geometry = buildParkGeometry(parkPolygons, y)
    const expected = parkPolygons
      .map((polygon) => polygonArea(polygon.map(decodeRing)))
      .reduce((sum, area) => sum + area, 0)
    expect(Math.abs(areaAtHeight(geometry, y) - expected) / expected).toBeLessThan(0.005)
    expect(upFacing(geometry, y)).toBe(true)
  })
})

describe('subway', () => {
  it('cycles the palette over the line ids in sorted order', () => {
    const colors = lineColors([{ id: 'b' }, { id: 'a' }, { id: 'c' }], ['p1', 'p2'])
    expect([...colors.entries()]).toEqual([
      ['a', 'p1'],
      ['b', 'p2'],
      ['c', 'p1'],
    ])
    expect(() => lineColors([{ id: 'a' }], [])).toThrow(/empty/)
  })

  it('writes one segment per path edge at the given height, coloured by line', () => {
    const lines = [
      {
        id: 'x',
        label: 'X',
        paths: [
          encodePath([
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ]),
        ],
      },
    ]
    const segments = subwaySegments(lines, new Map([['x', '#ff0000']]), 7)
    expect(segments.count).toBe(2)
    expect(Array.from(segments.positions)).toEqual([0, 7, -0, 10, 7, -0, 10, 7, -0, 10, 7, -10])
    expect(Array.from(segments.colors.slice(0, 3))).toEqual([1, 0, 0])
    expect(() => subwaySegments(lines, new Map(), 7)).toThrow(/no colour/)
  })

  it('builds the real network as one instanced segment buffer', () => {
    const colors = lineColors(subway.lines, ['#ff0000', '#00ff00'])
    const segments = subwaySegments(subway.lines, colors, 34)
    const edges = subway.lines.reduce(
      (n, line) => n + line.paths.reduce((m, path) => m + path.length / 2 - 1, 0),
      0,
    )
    expect(segments.count).toBe(edges)
    expect(buildSubwayGeometry(segments).instanceCount).toBe(edges)
  })
})

describe('stations', () => {
  const scale = sceneConfig.stations

  it('clamps the marker radius by camera distance', () => {
    expect(stationRadius(0, scale)).toBe(scale.minRadiusM)
    expect(stationRadius(1e9, scale)).toBe(scale.maxRadiusM)
    const mid = (scale.minRadiusM + scale.maxRadiusM) / 2 / scale.radiusPerDistance
    expect(stationRadius(mid, scale)).toBeCloseTo(mid * scale.radiusPerDistance)
  })

  it('places one instance per station at its scene position', () => {
    const positions = stationPositions(subway.stations, 30)
    const mesh = new InstancedMesh(
      buildStationGeometry(scale.radialSegments),
      new MeshBasicMaterial(),
      subway.stations.length,
    )
    writeStationMatrices(mesh, positions, 10, scale.heightM)
    const first = subway.stations[0]
    const p = new Vector3()
    const m = mesh.instanceMatrix.array
    p.set(m[12] ?? NaN, m[13] ?? NaN, m[14] ?? NaN)
    expect(p.toArray()).toEqual([first?.x, 30, -(first?.y ?? 0)])
    expect(m[0]).toBe(10)
    expect(m[5]).toBe(scale.heightM)
  })
})

describe('line labels', () => {
  it('groups line terminals by station, deterministically (N and W share Astoria)', () => {
    const chips = terminalChips(subway.lines, subway.stations)
    expect(terminalChips(subway.lines, subway.stations)).toEqual(chips)
    const astoria = subway.stations.find((s) => /Astoria-Ditmars/.test(s.name))
    expect(astoria).toBeDefined()
    const chip = chips.find((c) => c.stationId === astoria?.id)
    expect(chip?.lineIds).toEqual(['n', 'w'])
    // Every line has a chip somewhere.
    const labelled = new Set(chips.flatMap((c) => c.lineIds))
    expect(subway.lines.filter((line) => !labelled.has(line.id))).toEqual([])
  })

  it('lays out a square-ish atlas and maps cell 0 to its top-left', () => {
    expect(atlasLayout(29)).toEqual({ cols: 6, rows: 5 })
    expect(atlasLayout(1)).toEqual({ cols: 1, rows: 1 })
    expect(cellUv(0, { cols: 2, rows: 2 })).toEqual({ u0: 0, u1: 0.5, v0: 0.5, v1: 1 })
    expect(cellUv(3, { cols: 2, rows: 2 })).toEqual({ u0: 0.5, u1: 1, v0: 0, v1: 0.5 })
  })

  it('builds one up-facing quad per chip tile, centred on the station', () => {
    const chips = [{ stationId: 's', x: 1000, y: 2000, lineIds: ['n', 'w'] }]
    const cells = new Map([
      ['n', 0],
      ['w', 1],
    ])
    const sizes = { chipSizeM: 100, chipGapM: 10, offsetM: 150 }
    const geometry = buildLabelGeometry(chips, cells, { cols: 2, rows: 1 }, sizes, 36)
    expect(geometry.getIndex()?.count).toBe(12)
    expect(areaAtHeight(geometry, 36)).toBeCloseTo(2 * 100 * 100)
    expect(upFacing(geometry, 36)).toBe(true)
    geometry.computeBoundingBox()
    expect(geometry.boundingBox?.min.x).toBeCloseTo(1000 - 105)
    expect(geometry.boundingBox?.max.x).toBeCloseTo(1000 + 105)
    expect(geometry.boundingBox?.min.z).toBeCloseTo(-(2000 + 150 + 50))
    expect(() => buildLabelGeometry(chips, new Map(), { cols: 1, rows: 1 }, sizes, 0)).toThrow(
      /no atlas cell/,
    )
  })
})
