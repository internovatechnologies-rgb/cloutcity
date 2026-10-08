import { describe, expect, it } from 'vitest'
import { DistrictBuildingsMiniSchema } from '@/scene/buildings/schema'
import { GET, dynamic, dynamicParams, generateStaticParams } from './route'
import { GET as getBlocks } from '../../../blocks/[tier]/route'
import { BlocksMiniSchema } from '@/scene/buildings/schema'

const context = <T extends Record<string, string>>(params: T) => ({
  params: Promise.resolve(params),
})

describe('GET /geo/districts/<tier>/<id> and /geo/blocks/<tier>', () => {
  it('are prerendered for the known params only', () => {
    expect(dynamic).toBe('force-static')
    expect(dynamicParams).toBe(false)
    expect(generateStaticParams()).toContainEqual({ tier: 'mid', id: 'midtown' })
  })

  it('serve the district and blocks bodies the scene validates', async () => {
    const district = await GET(new Request('http://x'), context({ tier: 'low', id: 'flushing' }))
    expect(DistrictBuildingsMiniSchema.parse(await district.json()).district).toBe('flushing')
    const blocks = await getBlocks(new Request('http://x'), context({ tier: 'high' }))
    expect(BlocksMiniSchema.parse(await blocks.json()).tier).toBe('high')
    const missing = await GET(new Request('http://x'), context({ tier: 'low', id: 'hoboken' }))
    expect(missing.status).toBe(404)
  })
})
