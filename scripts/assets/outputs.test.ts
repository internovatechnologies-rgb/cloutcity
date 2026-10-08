/**
 * The committed model files (S04h): public/models holds exactly the manifest's GLBs, named after
 * their content, with no images or textures, only the compression extensions three r182 reads,
 * and one mesh with one primitive per static model.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelManifestSchema } from '../../src/lib/data/schemas/assets.ts'
import { readGltfContainer } from './fetch.ts'

const ROOT = join(import.meta.dirname, '../..')
const MODELS = join(ROOT, 'public/models')
const manifest = ModelManifestSchema.parse(
  JSON.parse(readFileSync(join(ROOT, 'data/assets/manifest.json'), 'utf8')),
)

const files = new Map(
  manifest.models.flatMap((model) =>
    Object.values(model.tiers).map((tier) => [tier.file, model] as const),
  ),
)

interface GlbJson {
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number }[] }[]
  images?: unknown[]
  textures?: unknown[]
  samplers?: unknown[]
  materials?: { pbrMetallicRoughness?: { baseColorTexture?: unknown } }[]
  extensionsUsed?: string[]
  extensionsRequired?: string[]
  skins?: unknown[]
  animations?: { name?: string }[]
}

const glbJson = (file: string) =>
  readGltfContainer(new Uint8Array(readFileSync(join(ROOT, 'public', file)))).json as GlbJson

describe('public/models', () => {
  it('holds only .glb files, exactly the manifest’s', () => {
    const onDisk = readdirSync(MODELS).sort()
    expect(onDisk.every((name) => name.endsWith('.glb'))).toBe(true)
    expect(onDisk).toEqual([...files.keys()].map((file) => file.replace('/models/', '')).sort())
  })

  it.each([...files.keys()])('%s is named after its sha256 and matches the manifest', (file) => {
    const bytes = readFileSync(join(ROOT, 'public', file))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    expect(file).toContain(`.${sha256.slice(0, 8)}.glb`)
    const tier = Object.values(files.get(file)?.tiers ?? {}).find((t) => t.file === file)
    expect(tier?.sha256).toBe(sha256)
    expect(tier?.bytes).toBe(bytes.byteLength)
  })

  it.each([...files.keys()])('%s ships no images, textures or UVs', (file) => {
    const json = glbJson(file)
    expect(json.images ?? []).toEqual([])
    expect(json.textures ?? []).toEqual([])
    expect(json.samplers ?? []).toEqual([])
    for (const material of json.materials ?? []) {
      expect(material.pbrMetallicRoughness?.baseColorTexture).toBeUndefined()
    }
    for (const prim of (json.meshes ?? []).flatMap((mesh) => mesh.primitives)) {
      expect(
        Object.keys(prim.attributes).filter((name) => /^(?:TEXCOORD|TANGENT)/.test(name)),
      ).toEqual([])
      expect(Object.keys(prim.attributes)).toContain('COLOR_0')
    }
  })

  it.each([...files.keys()])('%s needs only meshopt compression and quantization', (file) => {
    const json = glbJson(file)
    const allowed = ['EXT_meshopt_compression', 'KHR_mesh_quantization']
    expect((json.extensionsUsed ?? []).filter((name) => !allowed.includes(name))).toEqual([])
    expect(json.extensionsRequired ?? []).toContain('EXT_meshopt_compression')
  })

  it('merges every static model into one mesh with one primitive', () => {
    for (const [file, model] of files) {
      if (model.kind !== 'static') continue
      const json = glbJson(file)
      expect(json.meshes?.length, file).toBe(1)
      expect(json.meshes?.[0]?.primitives.length, file).toBe(1)
      expect(json.skins ?? [], file).toEqual([])
      expect(json.animations ?? [], file).toEqual([])
    }
  })

  it('keeps one skinned mesh per avatar part and only the listed clips on the rig', () => {
    for (const [file, model] of files) {
      const json = glbJson(file)
      if (model.kind === 'skinned') {
        expect(json.meshes?.length, file).toBe(1)
        expect(json.skins?.length, file).toBe(1)
        expect(json.animations ?? [], file).toEqual([])
      }
      if (model.kind === 'rig') {
        expect(json.meshes ?? [], file).toEqual([])
        expect((json.animations ?? []).map((clip) => clip.name).sort()).toEqual(
          [...model.clips].sort(),
        )
      }
    }
  })
})
