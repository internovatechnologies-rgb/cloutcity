/**
 * CloutMeter is presentational (S13): it renders the props it is given and must not reach for
 * the store or the engine itself, so it stays reusable and out of the store's chunk. The
 * store-backed adapter is the HUD's live island (HudLive.tsx).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, 'CloutMeter.tsx'), 'utf8')
const imports = [...source.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map(
  (match) => match[1],
)

describe('CloutMeter', () => {
  it('imports neither the store nor the engine, and formats numbers with the shared formatter', () => {
    expect(imports.length).toBeGreaterThan(0)
    expect(
      imports.filter((spec) => spec?.startsWith('@/state') || spec?.startsWith('@/engine')),
    ).toEqual([])
    expect(imports).toContain('@/lib/format')
  })
})
