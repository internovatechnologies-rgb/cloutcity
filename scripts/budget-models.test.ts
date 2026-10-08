import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelManifestSchema } from '../src/lib/data/schemas/assets.ts'
import { loaderLeaks, modelBudgetLines, modelBytes, phaseBytes } from './budget-models.ts'

const ROOT = join(import.meta.dirname, '..')
const read = (file: string): unknown => JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
const manifestJson = read('data/assets/manifest.json')
const perfJson = read('data/config/perf.json')
const sceneJson = read('data/config/scene.json')
const manifest = ModelManifestSchema.parse(manifestJson)

describe('modelBytes', () => {
  it('counts a file shared by two tiers or models once', () => {
    const rig = manifest.models.find((model) => model.id === 'avatar-rig')
    if (rig === undefined) throw new Error('rig missing')
    const twice = { ...manifest, models: [rig, { ...rig, id: 'rig-copy' }] }
    expect(modelBytes(twice, 'mid', () => true)).toEqual({
      files: 1,
      gzBytes: rig.tiers.mid.gzBytes,
    })
  })
})

describe('phaseBytes', () => {
  it('covers every model once per tier', () => {
    const total = phaseBytes(manifest)
      .filter((entry) => entry.tier === 'high')
      .reduce((sum, entry) => sum + entry.gzBytes, 0)
    expect(total).toBe(modelBytes(manifest, 'high', () => true).gzBytes)
  })
})

describe('loaderLeaks', () => {
  it('names the files that carry the glTF loader', () => {
    const files = new Map([
      ['shell.js', 'function a(){}'],
      ['three.js', 'n.EXT_meshopt_compression="EXT_meshopt_compression"'],
    ])
    expect(loaderLeaks(files)).toEqual(['three.js'])
  })
})

describe('modelBudgetLines', () => {
  it('passes the committed manifest with a clean shell', () => {
    const lines = modelBudgetLines(manifestJson, perfJson, sceneJson, new Map([['a.js', '']]))
    expect(lines.every((line) => line.ok)).toBe(true)
    expect(
      lines.filter((line) => line.text.startsWith('PASS Models on the playable')),
    ).toHaveLength(3)
    expect(
      lines.some((line) => line.text.includes('Player avatar after the map draws (low)')),
    ).toBe(true)
  })

  it('fails when the loader reaches the shell', () => {
    const lines = modelBudgetLines(
      manifestJson,
      perfJson,
      sceneJson,
      new Map([['/_next/static/chunks/x.js', 'KHR_materials_emissive_strength']]),
    )
    expect(lines.at(-1)).toEqual({
      ok: false,
      text: 'FAIL Model loader reached the shell JS: /_next/static/chunks/x.js',
    })
  })

  it('fails when the playable models alone break the bytes-to-playable budget', () => {
    const tight = { totalBytesToPlayableGzKB: { low: 1, mid: 1, high: 1 } }
    const lines = modelBudgetLines(manifestJson, tight, sceneJson, new Map())
    expect(lines.filter((line) => !line.ok)).toHaveLength(3)
  })

  it('rejects a player avatar part missing from the manifest', () => {
    const scene = { models: { player: { head: 'head-nobody', body: 'body-female-a' } } }
    expect(() => modelBudgetLines(manifestJson, perfJson, scene, new Map())).toThrow(/head-nobody/)
  })
})
