/**
 * Every committed GLB loads with the runtime's own decoder: three r182's GLTFLoader with the
 * MeshoptDecoder it bundles (meshoptimizer 0.22). This is the gate on the vertex codec pin (v0):
 * a stream only a newer decoder understands fails here, not in a player's browser. Triangle
 * counts, custom attributes, skins and clips match the manifest.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BufferAttribute, type BufferGeometry, Box3, Mesh, SkinnedMesh, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { describe, expect, it } from 'vitest'
import { ModelManifestSchema } from '../../src/lib/data/schemas/assets.ts'

const ROOT = join(import.meta.dirname, '../..')
const manifest = ModelManifestSchema.parse(
  JSON.parse(readFileSync(join(ROOT, 'data/assets/manifest.json'), 'utf8')),
)
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)

const cases = manifest.models.flatMap((model) =>
  (['low', 'mid', 'high'] as const).map((tier) => ({ model, tier, file: model.tiers[tier].file })),
)

async function load(file: string) {
  const bytes = readFileSync(join(ROOT, 'public', file))
  return loader.parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    '',
  )
}

const triangles = (geometry: BufferGeometry) =>
  (geometry.index?.count ?? geometry.getAttribute('position').count) / 3

describe('three r182 GLTFLoader + bundled MeshoptDecoder', () => {
  it.each(cases)(
    '$file ($model.id, $tier) decodes and matches the manifest',
    async ({ model, tier, file }) => {
      const gltf = await load(file)
      const meshes: Mesh[] = []
      gltf.scene.traverse((object) => {
        if (object instanceof Mesh) meshes.push(object)
      })
      expect(meshes.reduce((sum, mesh) => sum + triangles(mesh.geometry), 0)).toBe(
        model.tiers[tier].triangles,
      )
      expect(gltf.animations.map((clip) => clip.name).sort()).toEqual([...model.clips].sort())
      for (const mesh of meshes) {
        expect(mesh instanceof SkinnedMesh).toBe(model.kind === 'skinned')
        const { attributes } = mesh.geometry
        expect(attributes.color, 'vertex colours').toBeDefined()
        // Night-glow contract (S04f): `_emissive` is a linear RGB colour per vertex, zero = no glow.
        const glow = attributes._emissive as BufferAttribute | undefined
        if (glow !== undefined) expect(glow.itemSize).toBe(3)
        const slot = attributes._slot as BufferAttribute | undefined
        if (slot !== undefined) {
          const values = Array.from(slot.array as ArrayLike<number>)
          expect(Math.max(...values)).toBeLessThanOrEqual(model.slots.length)
        }
      }
      if (tier === 'high' && model.kind !== 'rig') {
        expect(meshes.some((mesh) => mesh.geometry.attributes._emissive !== undefined)).toBe(
          model.emissive,
        )
      }
    },
  )

  it('stands every avatar part upright at a person’s height in its bind pose', async () => {
    const body = manifest.models.find((model) => model.id === 'body-female-a')
    const head = manifest.models.find((model) => model.id === 'head-female-a')
    if (body === undefined || head === undefined) throw new Error('avatar parts missing')
    const box = new Box3()
    const point = new Vector3()
    for (const part of [body, head]) {
      const gltf = await load(part.tiers.high.file)
      gltf.scene.updateMatrixWorld(true)
      gltf.scene.traverse((object) => {
        if (!(object instanceof SkinnedMesh)) return
        object.skeleton.update()
        const count = object.geometry.getAttribute('position').count
        for (let i = 0; i < count; i++) {
          object.getVertexPosition(i, point)
          box.expandByPoint(point.applyMatrix4(object.matrixWorld))
        }
      })
    }
    expect(box.min.y).toBeGreaterThanOrEqual(-0.01)
    expect(box.max.y).toBeGreaterThan(1.5)
    expect(box.max.y).toBeLessThan(2)
  })
})
