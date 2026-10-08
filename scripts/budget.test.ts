import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APARTMENT_MARKER,
  assertGeoBaseBody,
  BOOT_ISLAND_FEATURES,
  bootIslandFiles,
  checkBudget,
  chunkModules,
  containsMarker,
  duplicateModules,
  extractScripts,
  findLoaders,
  gzipBytes,
  hasMarker,
  lazyChunkFiles,
  readApartmentChunkLimit,
  readLimits,
  SCENE_FEATURE,
  sceneSet,
  staticChunkName,
  staticFilePath,
  threeRevisions,
  type BootIsland,
  PRECACHE_FORBIDDEN,
  perfOverridePath,
  precacheProblems,
  workerWarmUrls,
} from './budget'

const ROOT = resolve(import.meta.dirname, '..')

describe('extractScripts', () => {
  it('collects external chunks once and inline bodies, skipping data blocks and nomodule', () => {
    const html = [
      '<script src="/_next/static/chunks/a.js" async=""></script>',
      '<script src="/_next/static/chunks/a.js"></script>',
      '<script>self.__next_f.push([1,"x"])</script>',
      '<script type="application/ld+json">{"@type":"Game"}</script>',
      '<script type="module" src="/_next/static/chunks/b.js"></script>',
      '<script>  </script>',
      '<script src="/_next/static/chunks/polyfill.js" noModule=""></script>',
    ].join('')

    expect(extractScripts(html)).toEqual({
      external: ['/_next/static/chunks/a.js', '/_next/static/chunks/b.js'],
      inline: ['self.__next_f.push([1,"x"])'],
    })
  })
})

describe('staticFilePath and staticChunkName', () => {
  it('map a static URL into the build directory and drop the query', () => {
    expect(staticFilePath('/_next/static/chunks/a.js?v=1', '/dist')).toBe(
      join('/dist', 'static', 'chunks/a.js'),
    )
    expect(staticChunkName('/_next/static/chunks/a.js#x')).toBe('static/chunks/a.js')
  })

  it('reject scripts from elsewhere and path traversal', () => {
    expect(() => staticFilePath('https://cdn.example/x.js', '/dist')).toThrow(/outside/)
    expect(() => staticFilePath('/_next/static/../../etc/passwd', '/dist')).toThrow(/traversal/)
    expect(() => staticChunkName('/_next/static/chunks/%2e%2e/x.js')).toThrow(/traversal/)
  })
})

describe('checkBudget', () => {
  it('passes at the limit and fails one byte over', () => {
    expect(checkBudget('shell', 180_000, 180).ok).toBe(true)
    expect(checkBudget('shell', 180_001, 180).ok).toBe(false)
    expect(checkBudget('shell', 123_456, 180).actualKB).toBe(123.5)
  })
})

describe('readLimits', () => {
  const valid = {
    shellJsGzKB: 180,
    sceneChunkJsGzKB: 350,
    totalJsToPlayableGzKB: 550,
    baseGeoGzKB: 400,
    districtBuildingsGzKB: { low: 150, mid: 300, high: 400 },
  }

  it('reads the limits the budget enforces from perf.json', () => {
    const perf = JSON.parse(readFileSync(join(ROOT, 'data/config/perf.json'), 'utf8')) as object
    expect(readLimits(perf)).toEqual(valid)
    expect(readLimits({ ...valid, other: true })).toEqual(valid)
  })

  it.each([
    ['shellJsGzKB', { ...valid, shellJsGzKB: 0 }],
    ['sceneChunkJsGzKB', { ...valid, sceneChunkJsGzKB: '350' }],
    ['totalJsToPlayableGzKB', { ...valid, totalJsToPlayableGzKB: -1 }],
    ['baseGeoGzKB', { ...valid, baseGeoGzKB: undefined }],
    ['districtBuildingsGzKB.mid', { ...valid, districtBuildingsGzKB: { low: 150, high: 400 } }],
  ])('names an invalid %s', (field, perf) => {
    expect(() => readLimits(perf)).toThrow(new RegExp(field.replace('.', '\\.')))
  })

  it('rejects a non-object', () => {
    expect(() => readLimits(null)).toThrow(/perf\.json/)
  })
})

describe('gzipBytes', () => {
  it('compresses repetitive input below its raw size', () => {
    const raw = 'a'.repeat(10_000)
    expect(gzipBytes(raw)).toBeLessThan(raw.length)
  })
})

describe('hasMarker', () => {
  it('matches a whole marker id only', () => {
    expect(hasMarker('x="cc-feature:event"', 'cc-feature:event')).toBe(true)
    expect(hasMarker('x="cc-feature:event-sheet"', 'cc-feature:event')).toBe(false)
    expect(hasMarker('"cc-feature:events" "cc-feature:event"', 'cc-feature:event')).toBe(true)
  })
})

describe('readApartmentChunkLimit', () => {
  it('reads a positive limit and rejects anything else', () => {
    expect(readApartmentChunkLimit({ apartmentChunkJsGzKB: 40 })).toBe(40)
    expect(() => readApartmentChunkLimit({})).toThrow(/apartmentChunkJsGzKB/)
    expect(() => readApartmentChunkLimit({ apartmentChunkJsGzKB: 0 })).toThrow()
  })
})

describe('containsMarker', () => {
  it('finds the whole marker only, never as the start of a longer id', () => {
    expect(containsMarker(`x="${APARTMENT_MARKER}"`, APARTMENT_MARKER)).toBe(true)
    expect(containsMarker(`x="${APARTMENT_MARKER}-extra"`, APARTMENT_MARKER)).toBe(false)
    expect(containsMarker(`"${APARTMENT_MARKER}x" "${APARTMENT_MARKER}"`, APARTMENT_MARKER)).toBe(
      true,
    )
    expect(containsMarker('cc-feature:city-scene', APARTMENT_MARKER)).toBe(false)
  })
})

describe('lazyChunkFiles', () => {
  const isApartment = (file: string) => file === 'static/chunks/room.js'

  it('splits the city 3D chunk from what only the apartment import adds', () => {
    const manifest = {
      '1': { id: 1, files: ['static/chunks/scene.js', 'static/chunks/three.js'] },
      '2': { id: 2, files: ['static/chunks/three.js', 'static/chunks/room.js'] },
      '3': { id: 3, files: ['static/chunks/scene.js', 'static/css/scene.css'] },
    }
    expect(lazyChunkFiles(manifest, [], isApartment)).toEqual({
      scene: ['static/chunks/scene.js', 'static/chunks/three.js'],
      apartment: ['static/chunks/room.js'],
    })
  })

  it('leaves out shell scripts, CSS and duplicates', () => {
    const manifest = {
      '1': { id: 1, files: ['static/chunks/scene.js', 'static/chunks/shared.js'] },
      '2': { id: 2, files: ['static/chunks/room.js', 'static/chunks/shared.js'] },
    }
    expect(lazyChunkFiles(manifest, ['/_next/static/chunks/shared.js?v=1'], isApartment)).toEqual({
      scene: ['static/chunks/scene.js'],
      apartment: ['static/chunks/room.js'],
    })
  })

  it('fails fast without exactly one apartment import, or without a city chunk', () => {
    const city = { '1': { id: 1, files: ['static/chunks/scene.js'] } }
    expect(() => lazyChunkFiles(city, [], isApartment)).toThrow(/found 0/)
    const twice = {
      ...city,
      '2': { id: 2, files: ['static/chunks/room.js'] },
      '3': { id: 3, files: ['static/chunks/room.js', 'static/chunks/x.js'] },
    }
    expect(() => lazyChunkFiles(twice, [], isApartment)).toThrow(/found 2/)
    const roomOnly = { '2': { id: 2, files: ['static/chunks/room.js'] } }
    expect(() => lazyChunkFiles(roomOnly, [], isApartment)).toThrow(/no lazy JS/)
  })

  it('fails fast on an unknown format, an empty manifest or path traversal', () => {
    expect(() => lazyChunkFiles([], [], isApartment)).toThrow(/format/)
    expect(() => lazyChunkFiles({ '1': { files: 'x.js' } }, [], isApartment)).toThrow(/format/)
    expect(() => lazyChunkFiles({}, [], isApartment)).toThrow(/no lazy JS/)
    expect(() =>
      lazyChunkFiles({ '1': { files: ['static/../../x.js'] } }, [], isApartment),
    ).toThrow(/traversal/)
  })
})

/** Turbopack's compiled `import()` (Next 16), as in a real shell chunk. */
const loader = (files: readonly string[], id = 1) =>
  `,${id},s=>{s.v(t=>Promise.all(${JSON.stringify(files)}.map(t=>s.l(t))).then(()=>t(${id})))}`

describe('findLoaders', () => {
  it('reads every loader file list in a chunk', () => {
    const text = `push([0${loader(['static/chunks/a.js', 'static/chunks/b.js'])}${loader(['static/chunks/c.js'], 2)}])`
    expect(findLoaders('static/chunks/shell.js', text)).toEqual([
      { chunk: 'static/chunks/shell.js', files: ['static/chunks/a.js', 'static/chunks/b.js'] },
      { chunk: 'static/chunks/shell.js', files: ['static/chunks/c.js'] },
    ])
    expect(findLoaders('x', 'no loaders here')).toEqual([])
  })

  it('fails loudly on a loader it cannot read', () => {
    const bad = (files: string) => `s.v(t=>Promise.all(${files}.map(t=>s.l(t))).then(()=>t(1)))`
    expect(() => findLoaders('x', bad('[a.js]'))).toThrow(/unreadable chunk loader/)
    expect(() => findLoaders('x', bad('["https://cdn/x.js"]'))).toThrow(/unreadable/)
    expect(() => findLoaders('x', bad('["static/../x.js"]'))).toThrow(/unreadable/)
  })
})

const THREE = 'var r={};r.s(["REVISION",0,"182","Scene",0,1])'

/** A build like the real one: a shell chunk with loaders for the scene and the boot islands. */
function build(overrides: Record<string, string | undefined> = {}) {
  const shellText = [
    'push([0',
    loader(['static/chunks/tiny.js', 'static/chunks/scene.js', 'static/chunks/zod.js'], 2135),
    loader(['static/chunks/welcome.js', 'static/chunks/zod.js'], 7),
    loader(['static/chunks/host.js', 'static/chunks/store.js'], 8),
    loader(['static/chunks/later.js', 'static/chunks/zod.js'], 9),
    '])',
  ].join('')
  const files: Record<string, string | undefined> = {
    'static/chunks/shell.js': shellText,
    'static/chunks/tiny.js': 'tiny',
    'static/chunks/scene.js': `${THREE};x="${SCENE_FEATURE}"`,
    'static/chunks/zod.js': 'zod',
    'static/chunks/welcome.js': 'x="cc-feature:welcome"',
    'static/chunks/host.js': `push([0${loader(['static/chunks/sheet.js'], 3)}])`,
    'static/chunks/sheet.js': 'x="cc-feature:event-sheet"',
    'static/chunks/store.js': 'store',
    'static/chunks/later.js': 'x="cc-feature:place-sheet"',
    ...overrides,
  }
  const chunks = new Map(
    Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return { chunks, shell: ['static/chunks/shell.js'] }
}

const MANIFEST = {
  '2135': {
    id: 2135,
    files: ['static/chunks/tiny.js', 'static/chunks/scene.js', 'static/chunks/zod.js'],
  },
}

const ISLANDS: readonly BootIsland[] = [
  { marker: 'cc-feature:welcome', module: 'welcome' },
  { marker: 'cc-feature:event-sheet', module: 'host', nested: true },
]

describe('sceneSet', () => {
  it('finds the scene import by its marker and loader, minus shell files', () => {
    expect(sceneSet(build(), MANIFEST)).toEqual({
      files: ['static/chunks/scene.js', 'static/chunks/tiny.js', 'static/chunks/zod.js'],
      threeRevision: '182',
    })
    const shared = build()
    const withShared = { ...shared, shell: [...shared.shell, 'static/chunks/zod.js'] }
    expect(sceneSet(withShared, MANIFEST).files).not.toContain('static/chunks/zod.js')
  })

  it('fails when the scene marker is missing or in two chunks', () => {
    expect(() => sceneSet(build({ 'static/chunks/scene.js': THREE }), MANIFEST)).toThrow(
      /3D chunk: expected exactly one chunk with cc-feature:city-scene, found 0/,
    )
    expect(() =>
      sceneSet(build({ 'static/chunks/tiny.js': `"${SCENE_FEATURE}"` }), MANIFEST),
    ).toThrow(/found 2/)
  })

  it('does not take a longer marker id for the scene marker', () => {
    const longer = build({ 'static/chunks/scene.js': `${THREE};"${SCENE_FEATURE}-extra"` })
    expect(() => sceneSet(longer, MANIFEST)).toThrow(/found 0/)
  })

  it('accepts a second shell loader of the scene chunk (the preload) only when it fetches the same files', () => {
    const sceneFiles = ['static/chunks/tiny.js', 'static/chunks/scene.js', 'static/chunks/zod.js']
    const withPreload = (files: string[]) => {
      const base = build()
      const shell = base.chunks.get('static/chunks/shell.js') ?? ''
      return build({
        'static/chunks/shell.js': shell.replace('])', `${loader(files, 2136)}])`),
      })
    }
    expect(sceneSet(withPreload([...sceneFiles].reverse()), MANIFEST).files).toEqual([
      'static/chunks/scene.js',
      'static/chunks/tiny.js',
      'static/chunks/zod.js',
    ])
    expect(() => sceneSet(withPreload(['static/chunks/scene.js']), MANIFEST)).toThrow(
      /shell chunk loaders fetching static\/chunks\/scene\.js disagree/,
    )
  })

  it('fails when no shell loader fetches the scene chunk (format drift)', () => {
    const noLoader = build({ 'static/chunks/shell.js': 'push([0,1,t=>{}])' })
    expect(() => sceneSet(noLoader, MANIFEST)).toThrow(/shell chunk loader fetching/)
  })

  it('fails when the loadable manifest is malformed, lacks the import or disagrees', () => {
    expect(() => sceneSet(build(), [])).toThrow(/unexpected format/)
    expect(() => sceneSet(build(), { '1': { files: 'x.js' } })).toThrow(/unexpected format/)
    expect(() => sceneSet(build(), {})).toThrow(/react-loadable-manifest\.json entry/)
    const extra = {
      '2135': { files: [...MANIFEST['2135'].files, 'static/chunks/more.js', 'static/css/a.css'] },
    }
    expect(() => sceneSet(build(), extra)).toThrow(/disagree/)
  })

  it("picks the scene's entry when another import (the apartment's) shares its files", () => {
    const shared = {
      ...MANIFEST,
      '4242': { id: 4242, files: [...MANIFEST['2135'].files, 'static/chunks/room.js'] },
    }
    expect(sceneSet(build(), shared).files).toEqual([
      'static/chunks/scene.js',
      'static/chunks/tiny.js',
      'static/chunks/zod.js',
    ])
  })

  it('ignores CSS in the manifest entry', () => {
    const css = { '2135': { files: [...MANIFEST['2135'].files, 'static/css/scene.css'] } }
    expect(sceneSet(build(), css).files).toHaveLength(3)
  })

  it("fails when three's REVISION cannot be found (format drift)", () => {
    const noThree = build({ 'static/chunks/scene.js': `x="${SCENE_FEATURE}"` })
    expect(() => sceneSet(noThree, MANIFEST)).toThrow(/REVISION not found/)
  })

  it('fails on a second copy of three anywhere in the build', () => {
    const twice = build({ 'static/chunks/later.js': `${THREE};"cc-feature:place-sheet"` })
    expect(() => sceneSet(twice, MANIFEST)).toThrow(/three is bundled more than once/)
  })

  it('fails when three sits outside the 3D chunk', () => {
    const outside = build({
      'static/chunks/scene.js': `x="${SCENE_FEATURE}"`,
      'static/chunks/store.js': THREE,
    })
    expect(() => sceneSet(outside, MANIFEST)).toThrow(/outside the 3D chunk/)
  })

  it('fails when a file of the import is missing from the build', () => {
    expect(() => sceneSet(build({ 'static/chunks/tiny.js': undefined }), MANIFEST)).toThrow(
      /tiny\.js is missing/,
    )
  })
})

describe('threeRevisions', () => {
  it('lists every copy of three with its revision', () => {
    const chunks = new Map([
      ['a.js', THREE],
      ['b.js', 'nothing'],
      ['c.js', '"REVISION", 0, "170"'],
      // A second export of the same namespace in one chunk is the same copy.
      ['d.js', `${THREE};x.s(["REVISION",0,"182"])`],
    ])
    expect(threeRevisions(chunks)).toEqual([
      ['a.js', '182'],
      ['c.js', '170'],
      ['d.js', '182'],
    ])
  })
})

describe('bootIslandFiles', () => {
  it('finds each island through its loader, directly or through the chunk that loads it', () => {
    expect(bootIslandFiles(build(), ISLANDS)).toEqual(
      new Map([
        ['welcome', ['static/chunks/welcome.js', 'static/chunks/zod.js']],
        ['host', ['static/chunks/host.js', 'static/chunks/store.js']],
      ]),
    )
  })

  it('names the island when its marker is missing or duplicated', () => {
    const missing = build({ 'static/chunks/welcome.js': 'welcome' })
    expect(() => bootIslandFiles(missing, ISLANDS)).toThrow(
      /boot island welcome: expected exactly one chunk with cc-feature:welcome, found 0/,
    )
    const twice = build({ 'static/chunks/store.js': '"cc-feature:welcome"' })
    expect(() => bootIslandFiles(twice, ISLANDS)).toThrow(/found 2/)
  })

  it('fails when no shell loader fetches the island', () => {
    const lazyOnly = [{ marker: 'cc-feature:event-sheet', module: 'sheet' }]
    expect(() => bootIslandFiles(build(), lazyOnly)).toThrow(
      /boot island sheet: expected exactly one shell chunk loader fetching static\/chunks\/sheet\.js, found 0/,
    )
  })

  it('fails when no chunk loads a nested island', () => {
    const noHost = build({ 'static/chunks/host.js': 'host' })
    expect(() => bootIslandFiles(noHost, ISLANDS)).toThrow(
      /boot island host: expected exactly one chunk whose loader fetches/,
    )
  })

  it('fails when an island file is missing from the build', () => {
    expect(() => bootIslandFiles(build({ 'static/chunks/store.js': undefined }), ISLANDS)).toThrow(
      /boot island host: static\/chunks\/store\.js is missing/,
    )
  })
})

describe('assertGeoBaseBody', () => {
  it('accepts the base geo JSON and rejects anything else', () => {
    const body = {
      format: 'cc-geo-base-v1',
      version: 'x',
      land: {},
      water: {},
      parks: {},
      subway: {},
    }
    expect(() => assertGeoBaseBody(JSON.stringify(body))).not.toThrow()
    expect(() => assertGeoBaseBody('{not json')).toThrow(/not the base geo JSON/)
    expect(() => assertGeoBaseBody(JSON.stringify({ ...body, format: '' }))).toThrow(/base geo/)
    // JSON.stringify drops an undefined value, so the body has no subway layer.
    expect(() => assertGeoBaseBody(JSON.stringify({ ...body, subway: undefined }))).toThrow(
      /base geo/,
    )
    expect(() => assertGeoBaseBody('[]')).toThrow(/base geo/)
  })
})

describe('PERF-3 duplicate modules', () => {
  it('splits a Turbopack chunk into its modules', () => {
    const text = 'push([0,12,t=>{a()},34,(e,t,i)=>{b()},56,function(e){c()}])'
    expect([...chunkModules(text).keys()]).toEqual(['12', '34', '56'])
    expect(chunkModules(text).get('12')).toBe('t=>{a()}')
  })

  it('counts a module copied into several chunks, and only identical copies', () => {
    const big = `t=>{t.exports=${JSON.stringify('x'.repeat(2000))}}`
    const chunks = new Map([
      ['a.js', `push([0,1,${big},2,t=>{a()}])`],
      ['b.js', `push([0,1,${big},2,t=>{b()}])`],
      ['c.js', `push([0,1,${big}])`],
    ])
    const report = duplicateModules(chunks)
    expect(report.modules).toBe(1)
    expect(report.top).toEqual([['1', 3, report.extraGzBytes]])
    expect(report.extraGzBytes).toBe(2 * gzipBytes(big))
    expect(duplicateModules(new Map([['a.js', 'push([0,1,t=>{}])']])).modules).toBe(0)
  })
})

/** Runtime source files under src, tests excluded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !/\.test\.tsx?$/.test(file))
}

function resolveImport(spec: string, from: string): string {
  const base = spec.startsWith('@/')
    ? join(ROOT, 'src', spec.slice(2))
    : resolve(dirname(from), spec)
  const file = ['.tsx', '.ts']
    .map((ext) => base + ext)
    .find((path) => statSync(path, { throwIfNoEntry: false })?.isFile())
  if (file === undefined) throw new Error(`cannot resolve ${spec} from ${from}`)
  return file
}

interface IslandUse {
  readonly file: string
  readonly module: string
  readonly eager: boolean
}

const ISLAND_CALL =
  /lazyIsland\(\s*\(\)\s*=>\s*import\(\s*'([^']+)'\s*\)[\s\S]*?(\{[^{}]*\})\s*,?\s*\)/g

function islandUses(): IslandUse[] {
  const uses: IslandUse[] = []
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8')
    const calls = [...text.matchAll(ISLAND_CALL)]
    // Every call must parse, so an island written differently cannot slip past this check.
    const count = text.split('lazyIsland(').length - 1
    expect(calls.length, `${relative(ROOT, file)}: unparsed lazyIsland call`).toBe(count)
    for (const call of calls) {
      uses.push({
        file,
        module: relative(ROOT, resolveImport(call[1] ?? '', file)),
        eager: /\beager:\s*true\b/.test(call[2] ?? ''),
      })
    }
  }
  return uses
}

describe('BOOT_ISLAND_FEATURES', () => {
  const uses = islandUses()

  it('lists exactly the modules of the eager islands in src', () => {
    expect(uses.some((use) => !use.eager)).toBe(true)
    const eager = uses.filter((use) => use.eager).map((use) => use.module)
    expect(BOOT_ISLAND_FEATURES.map((island) => island.module).sort()).toEqual(eager.sort())
  })

  it.each(BOOT_ISLAND_FEATURES)('$module carries $marker', (island) => {
    const path = join(ROOT, island.module)
    const marked = (file: string) => hasMarker(readFileSync(file, 'utf8'), island.marker)
    if (island.nested !== true) {
      // The marker is rendered by the module or a module it statically imports.
      const text = readFileSync(path, 'utf8')
      const imports = [...text.matchAll(/^import [^'\n]*from '(\.[^']+|@\/[^']+)'/gm)]
        .map((match) => match[1] ?? '')
        .filter((spec) => spec.startsWith('.') || spec.startsWith('@/'))
      const candidates = [
        path,
        ...imports.flatMap((spec) => {
          try {
            return [resolveImport(spec, path)]
          } catch {
            return []
          }
        }),
      ]
      expect(candidates.some(marked)).toBe(true)
    } else {
      expect(marked(path)).toBe(false)
      const nested = uses.filter((use) => use.file === path).map((use) => join(ROOT, use.module))
      expect(nested.some(marked)).toBe(true)
    }
  })
})

describe('precacheProblems (S04e)', () => {
  const ok = ['/_next/static/chunks/a.js', '/', '/geo/base?v=0123456789ab']

  it('passes a precache holding the path to playable and the versioned base geo', () => {
    expect(precacheProblems(ok, ['static/chunks/a.js'])).toEqual([])
  })

  it('names every forbidden entry and every missing one', () => {
    expect(
      precacheProblems(
        ['/models/taxi.low.752dce5e.glb', '/audio/a.webm', '/_next/static/chunks/a.js.map'],
        ['static/chunks/a.js'],
      ),
    ).toEqual([
      'precaches /models/taxi.low.752dce5e.glb, which must load on demand or never be cached',
      'precaches /audio/a.webm, which must load on demand or never be cached',
      'precaches /_next/static/chunks/a.js.map, which must load on demand or never be cached',
      'does not precache static/chunks/a.js',
      'does not precache the versioned base geo (/geo/base?v=)',
    ])
  })

  it('forbids models, audio, maps and server routes, and nothing the app shell needs', () => {
    for (const url of [
      '/models/x.glb',
      '/x.glb',
      '/api/save',
      '/mod',
      '/og/card',
      '/serwist/sw.js',
      '/a.js.map',
    ]) {
      expect(PRECACHE_FORBIDDEN.test(url), url).toBe(true)
    }
    for (const url of [
      '/',
      '/offline',
      '/manifest.webmanifest',
      '/icons/icon-192.png',
      '/geo/base?v=1',
      '/_next/static/chunks/a.js',
      '/modern',
      '/apiary',
    ]) {
      expect(PRECACHE_FORBIDDEN.test(url), url).toBe(false)
    }
  })
})

describe('workerWarmUrls (S04e)', () => {
  it("reads each tier's versioned district and block URLs, once each", () => {
    const body =
      'c={districtUrls:{low:["/geo/districts/low/queens?v=abc","/geo/blocks/low?v=def","/geo/blocks/low?v=def"],mid:["/geo/blocks/mid?v=1"],high:[]}}'
    const warm = workerWarmUrls(body)
    expect(warm.get('low')).toEqual(['/geo/districts/low/queens?v=abc', '/geo/blocks/low?v=def'])
    expect(warm.get('mid')).toEqual(['/geo/blocks/mid?v=1'])
    expect(warm.get('high')).toBeUndefined()
  })

  it('ignores unversioned URLs', () => {
    expect(workerWarmUrls('"/geo/districts/low/queens"').size).toBe(0)
  })
})

describe('perfOverridePath', () => {
  it('reads --perf=<file>, and nothing otherwise', () => {
    expect(perfOverridePath(['--perf=tight.json'])).toBe('tight.json')
    expect(perfOverridePath([])).toBeNull()
    expect(perfOverridePath(['--other'])).toBeNull()
    expect(() => perfOverridePath(['--perf='])).toThrow(/needs a file path/)
  })
})
