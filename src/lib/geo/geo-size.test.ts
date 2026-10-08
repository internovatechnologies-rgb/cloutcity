/** Base geo stays inside perf.json `baseGeoGzKB`, with S04's tighter per-layer caps. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { perf } from '@/lib/data/config'
import { geoManifest } from '@/lib/data/geo'

const DATA = join(import.meta.dirname, '../../../data')

/** gzip -9 bytes (KB = 1000 bytes, the stricter reading of the budget). */
const gzBytes = (path: string) => gzipSync(readFileSync(join(DATA, path)), { level: 9 }).byteLength

/**
 * S04's own caps, well inside the 400 KB budget so later base layers (POIs, landmarks) fit.
 * Tightening them is fine; loosening one needs the whole budget re-checked.
 */
const LAYER_CAPS_KB: Readonly<Record<string, number>> = {
  'geo/land.derived.json': 60,
  'zones/zone-shapes.derived.json': 50,
  'zones/zones.derived.json': 5,
  'geo/parks.derived.json': 20,
  'geo/subway.derived.json': 60,
  'geo/water.derived.json': 1,
  'landmarks/frames.derived.json': 3,
}
const S04_TOTAL_CAP_KB = 250

const baseFiles = geoManifest.files.filter((f) => f.group === 'base').map((f) => f.path)

describe('base geo size', () => {
  it('the base group is exactly the layers with a cap', () => {
    expect([...baseFiles].sort()).toEqual(Object.keys(LAYER_CAPS_KB).sort())
  })

  it.each(Object.entries(LAYER_CAPS_KB))('%s is within %d KB gzipped', (path, capKB) => {
    expect(gzBytes(path)).toBeLessThanOrEqual(capKB * 1000)
  })

  it('the base total is within perf.json baseGeoGzKB and the S04 cap', () => {
    const total = baseFiles.reduce((sum, path) => sum + gzBytes(path), 0)
    expect(total).toBeLessThanOrEqual(perf.baseGeoGzKB * 1000)
    expect(total).toBeLessThanOrEqual(S04_TOTAL_CAP_KB * 1000)
  })
})
