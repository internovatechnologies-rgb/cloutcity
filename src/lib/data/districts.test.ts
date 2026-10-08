import { describe, expect, it } from 'vitest'
import { QUALITY_TIERS } from './schemas/config'
import { geoManifest } from './geo'
import {
  blocksDataPath,
  districtAssetUrls,
  districtAssets,
  districtDataPath,
  districtRouteParams,
  geoConfig,
  readBlocks,
  readDistrictBuildings,
} from './districts'

const hashOf = (path: string) => geoManifest.files.find((f) => f.path === path)?.sha256.slice(0, 12)

describe('district assets (S04d)', () => {
  it('versions every URL with its file hash, per tier, in geo.json order', () => {
    for (const tier of QUALITY_TIERS) {
      const assets = districtAssets(tier)
      expect(assets.districts.map((d) => d.id)).toEqual(geoConfig.districts.map((d) => d.id))
      for (const district of assets.districts) {
        expect(district.url).toBe(
          `/geo/districts/${tier}/${district.id}?v=${hashOf(districtDataPath(district.id, tier))}`,
        )
      }
      expect(assets.blocksUrl).toBe(`/geo/blocks/${tier}?v=${hashOf(blocksDataPath(tier))}`)
      expect(districtAssetUrls(tier)).toEqual([
        ...assets.districts.map((d) => d.url),
        assets.blocksUrl,
      ])
    }
  })

  it('prerenders every tier and district, and reads nothing else', async () => {
    expect(districtRouteParams()).toHaveLength(QUALITY_TIERS.length * geoConfig.districts.length)
    expect((await readDistrictBuildings('low', 'astoria'))?.district).toBe('astoria')
    expect(await readDistrictBuildings('ultra', 'astoria')).toBeNull()
    expect(await readDistrictBuildings('low', '../../package')).toBeNull()
    expect((await readBlocks('mid'))?.tier).toBe('mid')
    expect(await readBlocks('max')).toBeNull()
  })
})
