/**
 * The committed geo layers (written by `npm run geo:build`) are right where it matters for
 * play: known places land in the right borough and zone, open water is no borough, zones cover
 * every NTA exactly once, and every subway station sits on one of its lines.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import boundsJson from '@data/geo/bounds.json'
import { zones } from '@/lib/data/content'
import { geoManifest, land, parks, subway, water, zoneShapes } from '@/lib/data/geo'
import { decodePath, decodeRing } from './codec'
import { boroughAt, prepareAreas, zoneAt, type PreparedArea } from './lookup'
import {
  distanceToPolyline,
  interiorPoint,
  pointInPolygon,
  polygonArea,
  signedArea,
} from './polygon'
import { ORIGIN, PROJECTION_ID, project } from './projection'

const boroughs = prepareAreas(land.boroughs)
const zoneAreas = prepareAreas(zoneShapes.zones)

describe('known places', () => {
  it.each([
    ['Times Square', 40.758, -73.9855, 'manhattan', 'mn05'],
    ['the Unisphere', 40.7462, -73.845, 'queens', 'qn81'],
    ['Prospect Park', 40.6602, -73.969, 'brooklyn', 'bk55'],
    ['Belmont, the Bronx', 40.8615, -73.8904, 'bronx', 'bx06'],
    ['St George', 40.6417, -74.0775, 'staten-island', 'si01'],
  ])('%s is in %s, zone %s', (_name, lat, lng, borough, zone) => {
    const point = project({ lat, lng })
    expect(boroughAt(point, boroughs)).toBe(borough)
    expect(zoneAt(point, zoneAreas)).toBe(zone)
  })

  it('a point in the Upper Bay is in no borough and no zone', () => {
    const point = project({ lat: 40.665, lng: -74.055 })
    expect(boroughAt(point, boroughs)).toBeUndefined()
    expect(zoneAt(point, zoneAreas)).toBeUndefined()
  })
})

describe('derived layers', () => {
  const headers = [land, water, parks, subway, zoneShapes]

  it('every derived file is labelled derived, carries a notice and names the shared projection', () => {
    for (const file of headers) {
      expect(file.derived).toBe(true)
      expect(file.notice).toMatch(/derived/i)
      expect(file.projection).toEqual({
        id: PROJECTION_ID,
        originLat: ORIGIN.lat,
        originLng: ORIGIN.lng,
      })
    }
    expect(
      geoManifest.files.every((f) => f.path.endsWith('.derived.json') || f.path.endsWith('.md')),
    ).toBe(true)
  })

  it('land has the five boroughs, with outer rings counter-clockwise and holes clockwise', () => {
    expect(land.boroughs.map((b) => [b.boroCode, b.id])).toEqual([
      [1, 'manhattan'],
      [2, 'bronx'],
      [3, 'brooklyn'],
      [4, 'queens'],
      [5, 'staten-island'],
    ])
    for (const layer of [land.boroughs, zoneShapes.zones, parks.parks]) {
      for (const entry of layer) {
        for (const polygon of entry.polygons) {
          polygon.forEach((ring, index) => {
            const area = signedArea(decodeRing(ring))
            if (index === 0) expect(area).toBeGreaterThan(0)
            else expect(area).toBeLessThan(0)
          })
        }
      }
    }
  })

  it('all land lies inside the projected NYC extent', () => {
    const sw = project({ lat: boundsJson.south, lng: boundsJson.west })
    const ne = project({ lat: boundsJson.north, lng: boundsJson.east })
    // Same check as one assertion per vertex, computed once: the extremes of every land vertex.
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity
    for (const borough of land.boroughs) {
      for (const point of borough.polygons.flat().flatMap(decodeRing)) {
        minX = Math.min(minX, point.x)
        maxX = Math.max(maxX, point.x)
        minY = Math.min(minY, point.y)
        maxY = Math.max(maxY, point.y)
      }
    }
    expect(minX).toBeGreaterThanOrEqual(Math.floor(sw.x))
    expect(maxX).toBeLessThanOrEqual(Math.ceil(ne.x))
    expect(minY).toBeGreaterThanOrEqual(Math.floor(sw.y))
    expect(maxY).toBeLessThanOrEqual(Math.ceil(ne.y))
  })

  it('the sea covers the whole extent', () => {
    const sea = water.sea.map(decodeRing)
    for (const [lat, lng] of [
      [boundsJson.south, boundsJson.west],
      [boundsJson.north, boundsJson.east],
    ] as const) {
      expect(pointInPolygon(project({ lat, lng }), sea)).toBe(true)
    }
  })

  it('parks come from NTA types 9 and 7 and carry no names', () => {
    expect(parks.parks.length).toBeGreaterThan(40)
    expect(new Set(parks.parks.map((p) => p.kind))).toEqual(new Set(['park', 'cemetery']))
    for (const park of parks.parks) {
      expect(park.id).toBe(`park-${park.ntaCode.toLowerCase()}`)
      expect(park).not.toHaveProperty('name')
    }
  })
})

describe('zones', () => {
  it('there are 71 zones (one per 2020 CDTA) with unique ids', () => {
    expect(zones).toHaveLength(71)
    expect(new Set(zones.map((z) => z.id)).size).toBe(71)
    expect(zones.filter((z) => z.kind === 'district')).toHaveLength(59)
    for (const zone of zones) expect(zone.id).toBe(zone.cdtaCode.toLowerCase())
  })

  it('each of the 262 NTA codes is in exactly one zone, under its own CDTA', () => {
    const codes = zones.flatMap((z) => z.ntaCodes)
    expect(codes).toHaveLength(262)
    expect(new Set(codes).size).toBe(262)
    for (const zone of zones) {
      for (const code of zone.ntaCodes) expect(code.startsWith(zone.cdtaCode)).toBe(true)
    }
  })

  it('each zone borough matches its CDTA prefix', () => {
    const prefix = {
      BK: 'brooklyn',
      BX: 'bronx',
      MN: 'manhattan',
      QN: 'queens',
      SI: 'staten-island',
    }
    for (const zone of zones) {
      expect(zone.borough).toBe(prefix[zone.cdtaCode.slice(0, 2) as keyof typeof prefix])
    }
  })

  it('zone metadata and zone shapes match one to one', () => {
    expect(zoneShapes.zones.map((z) => z.id)).toEqual(zones.map((z) => z.id))
  })

  it('every zone centroid lies inside its own zone', () => {
    for (const zone of zones) expect(zoneAt(zone.centroid, zoneAreas)).toBe(zone.id)
  })

  it('zone names have no CDTA code or CD/JIA suffix', () => {
    for (const zone of zones) expect(zone.name).not.toMatch(/^[A-Z]{2}\d{2} |\((?:CD|JIA) \d+/)
  })
})

describe('subway', () => {
  const lineIds = new Set(subway.lines.map((line) => line.id))
  const paths = new Map(subway.lines.map((line) => [line.id, line.paths.map(decodePath)]))

  it('has every GTFS parent station and route', () => {
    expect(subway.stations).toHaveLength(496)
    expect(subway.lines).toHaveLength(29)
  })

  it('every station lies on a line it serves (within stationOnLineToleranceM)', () => {
    const off = subway.stations.filter((station) => {
      const distances = station.lines.flatMap((id) =>
        (paths.get(id) ?? []).map((path) => distanceToPolyline(station, path)),
      )
      return !(Math.min(...distances) <= 10)
    })
    expect(off.map((s) => s.id)).toEqual([])
  })

  it('every station names existing lines, a borough and an existing zone', () => {
    const zoneIds = new Set(zones.map((z) => z.id))
    for (const station of subway.stations) {
      expect(station.lines.length).toBeGreaterThan(0)
      for (const id of station.lines) expect(lineIds.has(id)).toBe(true)
      expect(zoneIds.has(station.zoneId)).toBe(true)
      expect([...station.lines].sort()).toEqual(station.lines)
    }
  })

  it('every terminal extension names a real line and station', () => {
    const stationIds = new Set(subway.stations.map((s) => s.id))
    for (const ext of subway.terminalExtensions) {
      expect(lineIds.has(ext.lineId)).toBe(true)
      expect(stationIds.has(ext.stationId)).toBe(true)
    }
  })
})

describe('stations at shorelines and borough edges', () => {
  const byId = new Map(subway.stations.map((s) => [s.id, s]))

  it.each([
    ['b06', 'Roosevelt Island', 'manhattan', 'mn08'],
    ['h04', 'Broad Channel', 'queens', 'qn14'],
    ['h11', 'Far Rockaway-Mott Av', 'queens', 'qn14'],
    ['h15', 'Rockaway Park-Beach 116 St', 'queens', 'qn14'],
    ['h01', 'Aqueduct Racetrack', 'queens', 'qn10'],
    ['d43', 'Coney Island-Stillwell Av', 'brooklyn', 'bk13'],
    ['d40', 'Brighton Beach', 'brooklyn', 'bk13'],
    ['l29', 'Canarsie-Rockaway Pkwy', 'brooklyn', 'bk18'],
    ['s31', 'St George', 'staten-island', 'si01'],
    ['s09', 'Tottenville', 'staten-island', 'si03'],
    ['a02', 'Inwood-207 St', 'manhattan', 'mn12'],
    ['101', 'Van Cortlandt Park-242 St', 'bronx', 'bx08'],
    ['601', 'Pelham Bay Park', 'bronx', 'bx10'],
    // Marble Hill is legally Manhattan but sits in Bronx Community District 8.
    ['106', 'Marble Hill-225 St', 'manhattan', 'bx08'],
  ])('%s %s is in %s, zone %s', (id, name, borough, zoneId) => {
    expect(byId.get(id)).toMatchObject({ name, borough, zoneId })
  })

  it("a station's borough matches its zone's borough, except Marble Hill", () => {
    const zoneBorough = new Map(zones.map((z) => [z.id, z.borough]))
    const mismatched = subway.stations
      .filter((s) => zoneBorough.get(s.zoneId) !== s.borough)
      .map((s) => s.id)
    expect(mismatched).toEqual(['106'])
  })

  it('stored borough and zone agree with a fresh lookup wherever the station is inside a shape', () => {
    for (const station of subway.stations) {
      expect(boroughAt(station, boroughs) ?? station.borough, station.id).toBe(station.borough)
      expect(zoneAt(station, zoneAreas) ?? station.zoneId, station.id).toBe(station.zoneId)
    }
  })

  it('station ids are the lower-cased GTFS stop ids, unique, with names', () => {
    expect(new Set(subway.stations.map((s) => s.id)).size).toBe(subway.stations.length)
    for (const station of subway.stations) {
      expect(station.id).toBe(station.gtfsStopId.toLowerCase())
      expect(station.name.trim()).not.toBe('')
    }
  })
})

describe('subway lines', () => {
  it('every line has a plain label, at least one path, and serves a station', () => {
    const served = new Set(subway.stations.flatMap((s) => s.lines))
    for (const line of subway.lines) {
      expect(line.id).toBe(line.gtfsRouteId.toLowerCase())
      expect(line.label).toMatch(/^[0-9A-Z]{1,3}$/)
      expect(line.paths.length).toBeGreaterThan(0)
      expect(served.has(line.id), line.id).toBe(true)
    }
  })

  it('carries no MTA route colours anywhere', () => {
    const text = readFileSync(
      join(import.meta.dirname, '../../../data/geo/subway.derived.json'),
      'utf8',
    )
    expect(text).not.toMatch(/colou?r/i)
    expect(text).not.toMatch(/#[0-9a-f]{6}\b/i)
  })

  it('terminal extensions stay within terminalGapMaxM and are only the known Q-shape gap', () => {
    expect(subway.terminalExtensions).toEqual([
      { lineId: 'n', stationId: 'q05', gapM: 103 },
      { lineId: 'q', stationId: 'q05', gapM: 103 },
      { lineId: 'r', stationId: 'q05', gapM: 103 },
    ])
  })
})

describe('layer consistency on a 300 m grid over the city', () => {
  const parkAreas = prepareAreas(parks.parks)
  const zoneBorough = new Map(zones.map((z) => [z.id, z.borough]))
  const containing = (point: { x: number; y: number }, areas: readonly PreparedArea[]) =>
    areas
      .filter((area) => area.polygons.some(({ rings, bbox }) => pointInPolygon(point, rings, bbox)))
      .map((area) => area.id)

  const samples: { land: string[]; zone: string[]; park: string[] }[] = []
  const sw = project({ lat: boundsJson.south, lng: boundsJson.west })
  const ne = project({ lat: boundsJson.north, lng: boundsJson.east })
  for (let x = Math.floor(sw.x); x <= ne.x; x += 300) {
    for (let y = Math.floor(sw.y); y <= ne.y; y += 300) {
      const point = { x, y }
      samples.push({
        land: containing(point, boroughs),
        zone: containing(point, zoneAreas),
        park: containing(point, parkAreas),
      })
    }
  }
  const onLand = samples.filter((s) => s.land.length > 0)

  it('boroughs, zones and parks never overlap each other', () => {
    expect(onLand.length).toBeGreaterThan(5000)
    expect(samples.filter((s) => s.land.length > 1)).toEqual([])
    expect(samples.filter((s) => s.zone.length > 1)).toEqual([])
    expect(samples.filter((s) => s.park.length > 1)).toEqual([])
  })

  it('zones cover the land and only the land, up to simplification slivers (< 0.2%)', () => {
    const landNoZone = onLand.filter((s) => s.zone.length === 0).length
    const zoneNoLand = samples.filter((s) => s.zone.length > 0 && s.land.length === 0).length
    expect(landNoZone / onLand.length).toBeLessThan(0.002)
    expect(zoneNoLand / onLand.length).toBeLessThan(0.002)
  })

  it('a zone lies in its own borough except Marble Hill (bx08) and Rikers Island (qn01)', () => {
    const strays = new Map<string, number>()
    for (const s of onLand) {
      const [land, zone] = [s.land[0], s.zone[0]]
      if (land === undefined || zone === undefined || zoneBorough.get(zone) === land) continue
      const key = `${zone}/${land}`
      strays.set(key, (strays.get(key) ?? 0) + 1)
    }
    const known = ['bx08/manhattan', 'qn01/bronx']
    for (const key of known) expect(strays.get(key) ?? 0, key).toBeGreaterThan(0)
    const slivers = [...strays].filter(([key]) => !known.includes(key))
    expect(slivers.reduce((sum, [, n]) => sum + n, 0)).toBeLessThanOrEqual(5)
  })
})

describe('parks against zones', () => {
  it("every park's interior point is inside the zone that lists the park's NTA", () => {
    for (const park of parks.parks) {
      const largest = park.polygons
        .map((polygon) => polygon.map(decodeRing))
        .reduce((best, polygon) => (polygonArea(polygon) > polygonArea(best) ? polygon : best))
      const zoneId = zoneAt(interiorPoint(largest), zoneAreas)
      const zone = zones.find((z) => z.id === zoneId)
      expect(zone?.ntaCodes, park.id).toContain(park.ntaCode)
    }
  })

  it('every park NTA code is a real NTA, and park ids are unique', () => {
    const codes = new Set(zones.flatMap((z) => z.ntaCodes))
    for (const park of parks.parks) expect(codes.has(park.ntaCode)).toBe(true)
    expect(new Set(parks.parks.map((p) => p.id)).size).toBe(parks.parks.length)
  })
})

describe('derived files carry no build timestamps', () => {
  it.each(geoManifest.files.filter((f) => f.path.endsWith('.json')).map((f) => f.path))(
    '%s has no date or time in it',
    (path) => {
      const text = readFileSync(join(import.meta.dirname, '../../../data', path), 'utf8')
      expect(text).not.toMatch(/\b20\d\d-[01]\d-[0-3]\d/)
      expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}/)
      expect(text).not.toMatch(/"(?:generated|built|created|timestamp|date)\w*"/i)
    },
  )
})
