import { describe, expect, it } from 'vitest'
import { SourcesSchema, checkOutputs, outputPath, readSources } from './build.ts'

describe('npm run audio:build', () => {
  it('the committed outputs, manifest, sources.json and SOURCES.md agree (--check)', async () => {
    expect(await checkOutputs()).toEqual([])
  })

  it('pins every download by sha256 and names only known downloads, over https', async () => {
    const sources = await readSources()
    const downloads = new Set(sources.downloads.map((download) => download.id))
    expect(sources.assets.filter((asset) => !downloads.has(asset.download))).toEqual([])
    expect(new Set(sources.assets.map((asset) => asset.id)).size).toBe(sources.assets.length)
    for (const download of sources.downloads) expect(download.url.startsWith('https://')).toBe(true)
  })

  it('rejects an http download and an unpinned hash', async () => {
    const sources = await readSources()
    const [first, ...rest] = sources.downloads
    const http = { ...sources, downloads: [{ ...first, url: 'http://example.org/a.ogg' }, ...rest] }
    expect(SourcesSchema.safeParse(http).success).toBe(false)
    const unpinned = { ...sources, downloads: [{ ...first, sha256: 'abc' }, ...rest] }
    expect(SourcesSchema.safeParse(unpinned).success).toBe(false)
  })

  it('writes each asset under /audio/<channel>/', () => {
    expect(outputPath({ id: 'ui-tap', channel: 'sfx' }, 'webm')).toBe('/audio/sfx/ui-tap.webm')
  })
})
