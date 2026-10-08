/**
 * Which hand-made models glow at night, and in which colours (S04f night-glow contract on S04h
 * models). Pinned so a catalog or pack change cannot quietly light up the wrong surfaces again:
 * GLOW-1 found Kenney's commercial buildings paint trim, frames and glass with one grey, so their
 * glow is off until S04i gives them real window panes, and the taxi's hood highlight sat next to
 * the lamp colour, so a tight remap pins it to taxi yellow (only the roof sign glows).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BufferAttribute, Color, Mesh, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { describe, expect, it } from 'vitest'
import { ModelManifestSchema } from '../../src/lib/data/schemas/assets.ts'

const ROOT = join(import.meta.dirname, '../..')
const read = (file: string): unknown => JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
const manifest = ModelManifestSchema.parse(read('data/assets/manifest.json'))
const theme = read('data/config/theme.json') as { models: Record<string, string> }
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)

/** Model id → the theme tokens its night glow may use. */
const GLOWING: Readonly<Record<string, readonly string[]>> = {
  taxi: ['lamp-200'],
  sedan: ['lamp-200'],
  hatchback: ['lamp-200'],
  streetlight: ['lamp-200'],
  'traffic-light': ['signal-500', 'amber-400', 'go-500'],
  'block-a': ['window-200'],
  'block-b': ['window-200'],
  'block-c': ['window-200'],
  'block-d': ['window-200'],
  'block-e': ['window-200'],
  'block-f': ['window-200'],
  'floor-lamp': ['lamp-200'],
  'table-lamp': ['lamp-200'],
}

async function glowOf(file: string) {
  const bytes = readFileSync(join(ROOT, 'public', file))
  const gltf = await loader.parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    '',
  )
  gltf.scene.updateMatrixWorld(true)
  const colours = new Set<string>()
  const points: Vector3[] = []
  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const glow = object.geometry.getAttribute('_emissive') as BufferAttribute | undefined
    if (glow === undefined) return
    const position = object.geometry.getAttribute('position')
    for (let i = 0; i < glow.count; i++) {
      const rgb = [glow.getX(i), glow.getY(i), glow.getZ(i)]
      if (rgb.every((v) => v === 0)) continue
      colours.add(rgb.map((v) => Math.round(v * 255)).join(','))
      points.push(new Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld))
    }
  })
  return { colours, points }
}

/** A token's colour as the build stores `_EMISSIVE`: linear RGB, 8-bit. */
function tokenGlow(token: string): string {
  const hex = theme.models[token]
  if (hex === undefined) throw new Error(`unknown token ${token}`)
  const c = new Color(hex)
  return [c.r, c.g, c.b].map((v) => Math.round(v * 255)).join(',')
}

describe('night glow per model', () => {
  it('only the listed models carry `_EMISSIVE`', () => {
    const glowing = manifest.models.filter((model) => model.emissive).map((model) => model.id)
    expect(glowing.sort()).toEqual(Object.keys(GLOWING).sort())
  })

  it.each(manifest.models.filter((model) => model.emissive).map((model) => [model.id, model]))(
    '%s glows only in its tokens on every tier',
    async (id, model) => {
      const allowed = new Set((GLOWING[id] ?? []).map(tokenGlow))
      for (const tier of ['low', 'mid', 'high'] as const) {
        const { colours } = await glowOf(model.tiers[tier].file)
        expect(colours.size, `${id} ${tier}`).toBeGreaterThan(0)
        for (const colour of colours) expect(allowed, `${id} ${tier} ${colour}`).toContain(colour)
      }
    },
  )

  it('the taxi glows only at its roof sign, not on the hood', async () => {
    const taxi = manifest.models.find((model) => model.id === 'taxi')
    if (taxi?.bounds === undefined) throw new Error('taxi missing')
    const roof = taxi.bounds.max[1] * 0.75
    for (const tier of ['low', 'high'] as const) {
      const { points } = await glowOf(taxi.tiers[tier].file)
      expect(points.length).toBeGreaterThan(0)
      for (const point of points) expect(point.y, `taxi ${tier}`).toBeGreaterThan(roof)
    }
  })
})
