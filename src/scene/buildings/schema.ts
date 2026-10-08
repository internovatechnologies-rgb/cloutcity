/**
 * Client-side validation of the building files the scene fetches (S04d): one district's masses
 * (/geo/districts/<tier>/<id>) and one tier's procedural blocks (/geo/blocks/<tier>). Mirrors
 * BuildingsFileSchema and BlocksFileSchema in src/lib/data/schemas/world.ts with `zod/mini`
 * (classic zod must not reach browser code); schema.test.ts runs the committed files and
 * malformed fixtures through both so they cannot drift apart.
 */
import * as z from 'zod/mini'
import { ORIGIN, PROJECTION_ID } from '@/lib/geo/projection'
import { BUILDING_DISTRICT_IDS, DERIVED_SOURCE_IDS } from '@/lib/geo/sources'
import { BOROUGH_IDS } from '../geo/schema'

/** QUALITY_TIERS (classic zod's config schema module; schema.test.ts keeps them equal). */
export const BUILDING_TIERS = ['low', 'mid', 'high'] as const

const metre = z.int()
const evenLength = z.refine<number[]>((coords) => coords.length % 2 === 0, 'odd coordinate count')
const ring = z.array(metre).check(z.minLength(6), evenLength)
const polygon = z.array(ring).check(z.minLength(1))
const positiveInt = z.int().check(z.gt(0))

const header = {
  derived: z.literal(true),
  notice: z.string().check(z.minLength(1)),
  sources: z.array(z.enum(DERIVED_SOURCE_IDS)).check(z.minLength(1)),
  projection: z.strictObject({
    id: z.literal(PROJECTION_ID),
    originLat: z.literal(ORIGIN.lat),
    originLng: z.literal(ORIGIN.lng),
  }),
  tier: z.enum(BUILDING_TIERS),
}

export const DistrictBuildingsMiniSchema = z
  .strictObject({
    format: z.literal('cc-buildings-v1'),
    ...header,
    district: z.enum(BUILDING_DISTRICT_IDS),
    origin: z.strictObject({ x: metre, y: metre }),
    h: z.array(positiveInt),
    r: z.array(polygon),
  })
  .check(z.refine((file) => file.h.length === file.r.length, 'h and r must be the same length'))
export type DistrictBuildings = z.infer<typeof DistrictBuildingsMiniSchema>

export const BlocksMiniSchema = z.strictObject({
  format: z.literal('cc-blocks-v1'),
  ...header,
  sizeM: positiveInt,
  groups: z.array(
    z
      .strictObject({
        borough: z.enum(BOROUGH_IDS),
        angleDeg: z.number().check(z.gte(-90), z.lte(90)),
        p: z.array(metre).check(z.minLength(2), evenLength),
        h: z.array(positiveInt).check(z.minLength(1)),
      })
      .check(z.refine((group) => group.p.length === 2 * group.h.length, 'one point per height')),
  ),
})
export type Blocks = z.infer<typeof BlocksMiniSchema>
