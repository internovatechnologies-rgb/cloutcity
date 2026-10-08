/**
 * data/assets/manifest.json (S04h): one entry per catalog model in catalog order, hashed files,
 * gzip sizes as `npm run budget` measures them, and an assetVersion that hashes the rest.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelManifestSchema } from '../../src/lib/data/schemas/assets.ts'
import { readCatalog } from './build.ts'
import { buildManifest, gzipSize } from './manifest.ts'
import type { BuiltModel } from './pipeline.ts'

const ROOT = join(import.meta.dirname, '../..')
const manifest = ModelManifestSchema.parse(
  JSON.parse(readFileSync(join(ROOT, 'data/assets/manifest.json'), 'utf8')),
)
const catalog = await readCatalog()

describe('data/assets/manifest.json', () => {
  it('lists every catalog model, in catalog order, with its catalog metadata', () => {
    expect(manifest.models.map((model) => model.id)).toEqual(
      catalog.models.map((model) => model.id),
    )
    for (const model of catalog.models) {
      const entry = manifest.models.find((m) => m.id === model.id)
      expect(entry).toMatchObject({
        kind: model.kind,
        category: model.category,
        loadPhase: model.loadPhase,
        instanced: model.instanced,
        nameKey: model.nameKey,
        slots: model.slots.map((slot) => slot.name),
        clips: model.clips,
      })
    }
  })

  it('hashes everything else into assetVersion', () => {
    const { assetVersion, ...rest } = manifest
    const expected = createHash('sha256')
      .update(JSON.stringify({ version: rest.version, models: rest.models }))
      .digest('hex')
      .slice(0, 16)
    expect(assetVersion).toBe(expected)
  })

  it('records gzip sizes the way npm run budget measures them', () => {
    for (const model of manifest.models.slice(0, 5)) {
      const bytes = readFileSync(join(ROOT, 'public', model.tiers.high.file))
      expect(model.tiers.high.gzBytes).toBe(gzipSize(new Uint8Array(bytes)))
    }
  })

  it('ships byte-identical tiers once, named after the highest tier they serve', () => {
    const [model] = catalog.models
    if (model === undefined) throw new Error('catalog has no models')
    const same = { bytes: new Uint8Array([1, 2, 3]), triangles: 1 }
    const built: BuiltModel = {
      model,
      tiers: { low: { bytes: new Uint8Array([9]), triangles: 0 }, mid: same, high: same },
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      emissive: false,
      colours: new Map(),
      warnings: [],
    }
    const { manifest: out, files } = buildManifest([built])
    const tiers = out.models[0]?.tiers
    expect(tiers?.mid.file).toBe(tiers?.high.file)
    expect(tiers?.high.file).toMatch(new RegExp(`^/models/${model.id}\\.high\\.[0-9a-f]{8}\\.glb$`))
    expect(tiers?.low.file).toMatch(/\.low\./)
    expect(files.size).toBe(2)
  })
})
