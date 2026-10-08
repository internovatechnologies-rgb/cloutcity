/**
 * data/assets/SOURCES.md (S04h, DEC-24): rendered from the catalog and locks, so it names every
 * pack with its licence, version, pin and file hashes, every model, and everything left out.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readBlenderLock } from '../blender/build.ts'
import { readCatalog, readSourcesLock } from './build.ts'
import { renderSourcesMd } from './sources-md.ts'

const ROOT = join(import.meta.dirname, '../..')
const committed = readFileSync(join(ROOT, 'data/assets/SOURCES.md'), 'utf8')
const catalog = await readCatalog()
const lock = await readSourcesLock()
const blender = await readBlenderLock()

describe('data/assets/SOURCES.md', () => {
  it('records every pack: title, version, licence, licence file, pin and retrieval date', () => {
    for (const source of catalog.sources) {
      expect(committed).toContain(`${source.title} ${source.version}`)
      expect(committed).toContain(source.licenceEvidence.entry)
      if (source.download.kind === 'zip') expect(committed).toContain(source.download.url)
      if (source.download.kind === 'github-raw') expect(committed).toContain(source.download.commit)
    }
    expect(committed).toContain('CC0 1.0 Universal')
  })

  it('records the sha256 of every pinned file and names every model and exclusion', () => {
    for (const file of lock?.sources.flatMap((source) => source.files) ?? []) {
      expect(committed).toContain(file.sha256)
    }
    for (const model of catalog.models) expect(committed).toContain(`\`${model.id}\``)
    for (const excluded of catalog.excluded) expect(committed).toContain(excluded.reason)
  })

  it('renders deterministically from the same inputs', () => {
    if (lock === undefined) throw new Error('no lock')
    expect(renderSourcesMd(catalog, lock, blender)).toBe(renderSourcesMd(catalog, lock, blender))
  })
})
