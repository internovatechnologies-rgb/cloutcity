/**
 * The client building schemas (zod/mini) accept and reject what the classic schemas in
 * src/lib/data/schemas/world.ts do, on the committed files and on malformed variants.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { geoConfig, blocksDataPath, districtDataPath } from '@/lib/data/districts'
import { QUALITY_TIERS } from '@/lib/data/schemas/config'
import { BlocksFileSchema, BuildingsFileSchema } from '@/lib/data/schemas/world'
import { BUILDING_TIERS, BlocksMiniSchema, DistrictBuildingsMiniSchema } from './schema'

type Json = Record<string, unknown>
const DATA = join(import.meta.dirname, '../../../data')
const read = (path: string) => JSON.parse(readFileSync(join(DATA, path), 'utf8')) as Json

describe('client building schemas', () => {
  it('list the same tiers as the config schema', () => {
    expect([...BUILDING_TIERS]).toEqual([...QUALITY_TIERS])
  })

  for (const tier of QUALITY_TIERS) {
    it(`${tier}: both accept every committed district file and the blocks file`, () => {
      for (const district of geoConfig.districts) {
        const file = read(districtDataPath(district.id, tier))
        expect(BuildingsFileSchema.safeParse(file).success, district.id).toBe(true)
        expect(DistrictBuildingsMiniSchema.safeParse(file).success, district.id).toBe(true)
      }
      const blocks = read(blocksDataPath(tier))
      expect(BlocksFileSchema.safeParse(blocks).success).toBe(true)
      expect(BlocksMiniSchema.safeParse(blocks).success).toBe(true)
    })
  }

  it('both reject malformed district files', () => {
    const file = read(districtDataPath('astoria', 'low'))
    const h = file.h as number[]
    const r = file.r as number[][][]
    const bad = [
      { ...file, format: 'cc-buildings-v0' },
      { ...file, h: h.slice(1) },
      { ...file, h: [0.5, ...h.slice(1)] },
      { ...file, district: 'hoboken' },
      { ...file, tier: 'ultra' },
      { ...file, name: 'any name' },
      { ...file, r: [[[1, 2, 3, 4]], ...r.slice(1)] },
    ]
    for (const [index, variant] of bad.entries()) {
      expect(BuildingsFileSchema.safeParse(variant).success, `classic #${index}`).toBe(false)
      expect(DistrictBuildingsMiniSchema.safeParse(variant).success, `mini #${index}`).toBe(false)
    }
  })

  it('both reject malformed blocks files', () => {
    const file = read(blocksDataPath('low'))
    const groups = file.groups as Json[]
    const first = groups[0] ?? {}
    const bad = [
      { ...file, sizeM: 0 },
      { ...file, groups: [{ ...first, borough: 'jersey' }] },
      { ...file, groups: [{ ...first, angleDeg: 120 }] },
      { ...file, groups: [{ ...first, h: [] }] },
      { ...file, groups: [{ ...first, p: [1, 2, 3] }] },
    ]
    for (const [index, variant] of bad.entries()) {
      expect(BlocksFileSchema.safeParse(variant).success, `classic #${index}`).toBe(false)
      expect(BlocksMiniSchema.safeParse(variant).success, `mini #${index}`).toBe(false)
    }
  })
})
