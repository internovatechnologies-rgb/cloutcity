/**
 * The committed district buildings and blocks (S04d, written by `npm run geo:build`): districts
 * sit where they should, the files stay inside perf.json, and nothing but numbers rides along.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { perf } from '@/lib/data/config'
import { geoManifest, land, parks, zoneShapes } from '@/lib/data/geo'
import { GeoConfigSchema, QUALITY_TIERS } from '@/lib/data/schemas/config'
import { BlocksFileSchema, BuildingsFileSchema } from '@/lib/data/schemas/world'
import { zones } from '@/lib/data/content'
import { decodePath, decodeRing } from './codec'
import { areaAt, boroughAt, prepareAreas, zoneAt } from './lookup'
import { distanceM, project } from './projection'
import { BUILDING_DISTRICT_IDS } from './sources'

const DATA = join(import.meta.dirname, '../../../data')
const read = (path: string) => readFileSync(join(DATA, path), 'utf8')
const config = GeoConfigSchema.parse(JSON.parse(read('config/geo.json')))
const boroughs = prepareAreas(land.boroughs)
const zoneAreas = prepareAreas(zoneShapes.zones)
const parkAreas = prepareAreas(parks.parks)

const tiered = geoManifest.files.filter((f) => f.group === 'district' || f.group === 'blocks')

describe('building districts', () => {
  it('config lists every district once, in source-id order', () => {
    expect(config.districts.map((d) => d.id)).toEqual([...BUILDING_DISTRICT_IDS])
  })

  it.each(config.districts.map((d) => [d.id, d] as const))(
    '%s: its centre is on land, in its borough, in a community district of that borough',
    (_id, district) => {
      const centre = project(district.center)
      expect(boroughAt(centre, boroughs)).toBe(district.borough)
      const zoneId = zoneAt(centre, zoneAreas)
      const zone = zones.find((z) => z.id === zoneId)
      expect(zone?.borough).toBe(district.borough)
      expect(zone?.kind).toBe('district')
      expect(areaAt(centre, parkAreas)).toBeUndefined()
    },
  )

  it('every district has a file per tier, valid, and its masses sit around its circle', () => {
    for (const district of config.districts) {
      const centre = project(district.center)
      for (const tier of QUALITY_TIERS) {
        const file = BuildingsFileSchema.parse(
          JSON.parse(read(`geo/districts/${district.id}.${tier}.derived.json`)),
        )
        expect(file).toMatchObject({ district: district.id, tier, derived: true })
        expect(file.h.length).toBeGreaterThan(0)
        for (const polygon of file.r) {
          for (const point of decodeRing(polygon[0] ?? [])) {
            const absolute = { x: point.x + file.origin.x, y: point.y + file.origin.y }
            // Centroids are inside the circle; big footprints may reach a little past it.
            expect(distanceM(absolute, centre)).toBeLessThan(district.radiusM + 250)
          }
        }
      }
    }
  })

  it('no building file carries a string past its header', () => {
    const strings = (value: unknown): unknown[] =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(strings)
          : value !== null && typeof value === 'object'
            ? Object.values(value).flatMap(strings)
            : []
    for (const file of tiered.filter((f) => f.group === 'district')) {
      const json = JSON.parse(read(file.path)) as Record<string, unknown>
      expect(strings([json.origin, json.h, json.r]), file.path).toEqual([])
    }
  })
})

describe('blocks', () => {
  it.each(QUALITY_TIERS)('%s: valid, outside every district circle and park, on land', (tier) => {
    const file = BlocksFileSchema.parse(JSON.parse(read(`geo/blocks.${tier}.derived.json`)))
    const circles = config.districts.map((d) => ({ centre: project(d.center), r: d.radiusM }))
    let count = 0
    for (const group of file.groups) {
      for (const point of decodePath(group.p)) {
        count++
        expect(boroughAt(point, boroughs)).toBe(group.borough)
        expect(areaAt(point, parkAreas)).toBeUndefined()
        expect(circles.every((c) => distanceM(point, c.centre) > c.r)).toBe(true)
      }
    }
    expect(count).toBeLessThanOrEqual(config.blocks.maxInstances[tier])
  })

  it('Manhattan blocks follow its rotated street grid', () => {
    const file = BlocksFileSchema.parse(JSON.parse(read('geo/blocks.mid.derived.json')))
    expect(file.groups.find((g) => g.borough === 'manhattan')?.angleDeg).toBe(29)
    expect(file.groups.find((g) => g.borough === 'queens')?.angleDeg).toBe(0)
  })
})

describe('per-tier size', () => {
  it.each(QUALITY_TIERS)(
    '%s: districts plus blocks stay within perf.json districtBuildingsGzKB',
    (tier) => {
      const total = tiered
        .filter((f) => f.tier === tier)
        .reduce((sum, f) => sum + gzipSync(read(f.path), { level: 9 }).byteLength, 0)
      expect(total).toBeLessThanOrEqual(perf.districtBuildingsGzKB[tier] * 1000)
    },
  )

  it('the manifest lists every district file per tier plus the blocks', () => {
    expect(tiered).toHaveLength((config.districts.length + 1) * QUALITY_TIERS.length)
  })
})
