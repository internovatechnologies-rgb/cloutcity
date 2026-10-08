/**
 * The landmark kit is code-built geometry on three alone: no React, no config loaders, no model
 * loaders. The only model files in public/ are the pinned CC0 pack builds listed in
 * data/assets/manifest.json (S04h, DEC-24); nothing else may ship there.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = import.meta.dirname
const ROOT = join(DIR, '../../..')
const sources = readdirSync(DIR, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.ts$/.test(entry.name))
  .filter((entry) => !/\.(test|fixture)\.ts$/.test(entry.name))
  .map((entry) => relative(DIR, join(entry.parentPath, entry.name)))
  .sort()

const specifiers = (code: string) =>
  [...code.matchAll(/^\s*(?:import|export)\s[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)].map(
    (match) => match[1] ?? '',
  )

/** What kit modules may import. Schema and config imports must be type-only. */
const ALLOWED = [
  /^three$/,
  /^three\/addons\/utils\/BufferGeometryUtils\.js$/,
  /^\.\.?\//,
  /^@\/lib\/landmarks\/metrics$/,
  /^@\/lib\/data\/schemas\/(?:landmarkModels|config|scene)$/,
]

describe('src/scene/landmarks', () => {
  it('finds the kit modules', () => {
    expect(sources).toEqual(
      expect.arrayContaining([
        'buildLandmark.ts',
        'materials.ts',
        'kit/primitives.ts',
        'kit/compose.ts',
        'kit/outline.ts',
        'archetypes/civicHall.ts',
        'archetypes/cantileverBridge.ts',
      ]),
    )
  })

  it.each(sources)('%s imports only three, BufferGeometryUtils and the kit', (file) => {
    const code = readFileSync(join(DIR, file), 'utf8')
    const specs = specifiers(code)
    expect(specs.filter((spec) => !ALLOWED.some((pattern) => pattern.test(spec)))).toEqual([])
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/Loader\b|\/loaders\/|\.(?:glb|gltf|obj|fbx|stl|ply|dae|usdz)\b/i)
    expect(code).not.toMatch(/from ['"]react|from ['"]@react-three/)
    // Schemas and config are read as types only; their loaders never reach the scene chunk.
    for (const match of code.matchAll(
      /^import\s+(type\s+)?[^'"]*?from\s+['"]@\/lib\/data\/schemas\/[^'"]+['"]/gm,
    )) {
      expect(match[1], `${file}: ${match[0]}`).toBe('type ')
    }
  })

  it('public/ ships only the 3D model files listed in the asset manifest', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'data/assets/manifest.json'), 'utf8')) as {
      models: { tiers: Record<string, { file: string }> }[]
    }
    const listed = new Set(
      manifest.models.flatMap((model) => Object.values(model.tiers).map((tier) => tier.file)),
    )
    const publicDir = join(ROOT, 'public')
    const unlisted = readdirSync(publicDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .filter((entry) => /\.(?:glb|gltf|obj|fbx|stl|ply|dae|3ds|usdz|drc|ktx2)$/i.test(entry.name))
      .map((entry) => '/' + relative(publicDir, join(entry.parentPath, entry.name)))
      .filter((file) => !listed.has(file))
    expect(unlisted).toEqual([])
  })
})
