/**
 * `npm run budget` end to end: runs the real script against throwaway build directories and
 * checks the exit code, so a budget that cannot fail, or a lookup that silently finds nothing,
 * is caught.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OPTIONAL_CHUNK_MARKERS } from '../src/lib/pwa/lazyChunks.ts'
import { BOOT_ISLAND_FEATURES, SCENE_FEATURE } from './budget'

const SCRIPT = join(import.meta.dirname, 'budget.ts')
const REPO = join(import.meta.dirname, '..')
/** The model lines read the real manifest and the player's avatar parts. */
const repoFile = (path: string) => readFileSync(join(REPO, path), 'utf8')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Incompressible-ish JS, so the gzipped size is predictable (well over 1 KB). */
function noisyChunk(seed: number, extra = ''): string {
  let body = ''
  for (let i = 0; i < 4000; i += 1) body += (((i + seed) * 2654435761) >>> 0).toString(36)
  return `var x="${body}";${extra}`
}

/** Limits every fake project gets unless a test overrides them. */
const DEFAULT_PERF = {
  shellJsGzKB: 180,
  sceneChunkJsGzKB: 350,
  totalJsToPlayableGzKB: 550,
  baseGeoGzKB: 400,
  districtBuildingsGzKB: { low: 150, mid: 300, high: 400 },
  apartmentChunkJsGzKB: 40,
  serviceWorkerGzKB: 15,
  precacheGzKB: 1000,
  totalBytesToPlayableGzKB: { low: 1200, mid: 1600, high: 2000 },
}

const THREE = '"REVISION",0,"182"'
const GEO_BODY = JSON.stringify({
  format: 'cc-geo-base-v1',
  version: 'test',
  land: [],
  water: [],
  parks: [],
  subway: [],
})

/** Turbopack's compiled `import()` (Next 16). */
const loader = (files: readonly string[], id: number) =>
  `,${id},s=>{s.v(t=>Promise.all(${JSON.stringify(files)}.map(t=>s.l(t))).then(()=>t(${id})))}`

const chunk = (name: string) => `static/chunks/${name}.js`

/** Every chunk on the fake build's path to playable: the shell, the 3D chunk and the islands. */
const PLAYABLE_CHUNKS = [
  'main',
  'scene',
  'shared',
  ...BOOT_ISLAND_FEATURES.map((_island, index) => `island${index}`),
]

const TIERS = ['low', 'mid', 'high'] as const

/**
 * A fake /serwist/sw.js (S04e): its injected precache manifest (the given chunks, `/` and the
 * versioned base geo) and, unless `warm` is false, the tier-warm URLs baked into its config.
 */
function workerBody(chunks: readonly string[], extra: readonly string[] = [], warm = true): string {
  const entries = [
    ...chunks.map((name) => `/_next/${chunk(name)}`),
    '/',
    '/geo/base?v=0123456789ab',
    ...extra,
  ].map((url) => `{url:"${url}",revision:null}`)
  const warmUrls = warm
    ? TIERS.map(
        (tier) =>
          `${tier}:["/geo/districts/${tier}/queens?v=abc123","/geo/blocks/${tier}?v=def456"]`,
      )
    : []
  return `var m=[${entries.join(',')}];var c={districtUrls:{${warmUrls.join(',')}}};`
}

/**
 * A fake build in the format Next 16 / Turbopack writes: a shell chunk referenced from the
 * prerendered `/`, whose loaders fetch the 3D chunk (with three and the scene marker) and every
 * boot island; the route's react-loadable-manifest.json, which also lists the apartment's
 * import (S16, whose room chunk renders its feature marker); the prerendered /geo/base body; and
 * a service worker (S04e) precaching the shell chunk and `/`.
 */
function fakeProject(perf: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'budget-'))
  dirs.push(root)
  const islands = BOOT_ISLAND_FEATURES.map((island, index) => ({
    ...island,
    name: `island${index}`,
  }))
  const shellLoaders = [
    loader([chunk('scene'), chunk('shared')], 2135),
    ...islands.map((island, index) => loader([chunk(island.name), chunk('shared')], 10 + index)),
  ]
  const build: Record<string, string> = {
    'data/config/perf.json': JSON.stringify({ ...DEFAULT_PERF, ...perf }),
    'data/config/scene.json': repoFile('data/config/scene.json'),
    'data/assets/manifest.json': repoFile('data/assets/manifest.json'),
    '.next/server/app/index.html':
      '<html><body><script src="/_next/static/chunks/main.js" async=""></script><script>self.__next_f=[]</script></body></html>',
    '.next/server/app/page/react-loadable-manifest.json': JSON.stringify({
      '2135': { id: 2135, files: [chunk('scene'), chunk('shared')] },
      '4242': { id: 4242, files: [chunk('scene'), chunk('room')] },
    }),
    '.next/server/app/serwist/sw.js.body': workerBody(PLAYABLE_CHUNKS),
    '.next/server/app/geo/base.body': GEO_BODY,
    [`.next/${chunk('main')}`]: noisyChunk(0, `push([0${shellLoaders.join('')}])`),
    [`.next/${chunk('scene')}`]: noisyChunk(7, `${THREE};x="${SCENE_FEATURE}"`),
    [`.next/${chunk('shared')}`]: noisyChunk(3),
    [`.next/${chunk('room')}`]: noisyChunk(13, 'var f="cc-feature:apartment-scene";'),
    [`.next/${chunk('sheet')}`]: 'x="cc-feature:event-sheet"',
    // PERF-7: one chunk per optional marker, none of them precached.
    ...Object.fromEntries(
      OPTIONAL_CHUNK_MARKERS.map(({ id, marker }) => [
        `.next/${chunk(id)}`,
        `x=${JSON.stringify(marker)}`,
      ]),
    ),
  }
  for (const island of islands) {
    build[`.next/${chunk(island.name)}`] =
      island.nested === true
        ? `push([0${loader([chunk('sheet')], 99)}])`
        : noisyChunk(11, `x="${island.marker}"`)
  }
  for (const [path, content] of Object.entries({ ...build, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** Adds prerendered district and block bodies for every tier. */
function withDistricts(root: string, tiers = ['low', 'mid', 'high'], seed = 21) {
  for (const tier of tiers) {
    mkdirSync(join(root, '.next/server/app/geo/districts', tier), { recursive: true })
    mkdirSync(join(root, '.next/server/app/geo/blocks'), { recursive: true })
    writeFileSync(
      join(root, `.next/server/app/geo/districts/${tier}/queens.body`),
      noisyChunk(seed),
    )
    writeFileSync(join(root, `.next/server/app/geo/blocks/${tier}.body`), noisyChunk(seed + 1))
  }
  return root
}

function runBudget(cwd: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
}

describe('budget CLI', () => {
  it('exits 0 and prints a line per budget when the build is under every limit', () => {
    const result = runBudget(fakeProject())
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatch(/^PASS Shell JS/m)
    expect(result.stdout).toMatch(/^PASS 3D chunk JS \(lazy\).*\n {2}three r182; /m)
    expect(result.stdout).toMatch(/^PASS Total JS to playable.*\n.*6 boot islands/m)
    expect(result.stdout).toMatch(/^PASS Base geo/m)
    expect(result.stdout).toMatch(/^SKIP District buildings/m)
    expect(result.stdout).toMatch(/^INFO PERF-3 duplicate modules \(report only\)/m)
    expect(result.status).toBe(0)
  })

  it.each([
    ['Shell JS', { shellJsGzKB: 1 }],
    ['3D chunk JS', { sceneChunkJsGzKB: 1 }],
    ['Total JS to playable', { totalJsToPlayableGzKB: 10 }],
    ['Base geo', { baseGeoGzKB: 0.01 }],
  ])('exits non-zero and prints FAIL when %s is over its limit', (name, perf) => {
    const result = runBudget(fakeProject(perf))
    expect(result.stdout).toMatch(new RegExp(`^FAIL ${name}`, 'm'))
    expect(result.status).toBe(1)
  })

  it('counts a file shared by the shell, the islands and the 3D chunk once in the total', () => {
    const result = runBudget(fakeProject())
    // main + scene + shared + 5 boot island chunks + the nested host: 9 distinct files.
    expect(result.stdout).toMatch(/; 9 files$/m)
  })

  it('exits non-zero when there is no build', () => {
    const root = fakeProject()
    rmSync(join(root, '.next'), { recursive: true })
    const result = runBudget(root)
    expect(result.stderr).toMatch(/npm run build/)
    expect(result.status).toBe(1)
  })

  it('exits non-zero when perf.json has no valid limit', () => {
    const result = runBudget(fakeProject({ totalJsToPlayableGzKB: 0 }))
    expect(result.stderr).toMatch(/totalJsToPlayableGzKB/)
    expect(result.status).toBe(1)
  })

  /** Removes one file from a fresh fake project. */
  const without = (path: string) => () => {
    const root = fakeProject()
    rmSync(join(root, path))
    return root
  }

  // One spawn per case: each run of the script takes about a second.
  it.each<[string, () => string, RegExp]>([
    [
      'a referenced chunk is missing',
      without(`.next/${chunk('main')}`),
      /main\.js is referenced but missing/,
    ],
    [
      'the loadable manifest is missing',
      without('.next/server/app/page/react-loadable-manifest.json'),
      /react-loadable-manifest/,
    ],
    [
      'the loadable manifest lacks the scene import',
      () => fakeProject({}, { '.next/server/app/page/react-loadable-manifest.json': '{}' }),
      /3D chunk: expected a react-loadable-manifest\.json entry/,
    ],
    [
      'the scene marker is missing (format drift)',
      () => fakeProject({}, { [`.next/${chunk('scene')}`]: noisyChunk(7, THREE) }),
      /cc-feature:city-scene, found 0/,
    ],
    [
      'the shell has no chunk loaders (format drift)',
      () => fakeProject({}, { [`.next/${chunk('main')}`]: noisyChunk(0) }),
      /shell chunk loader fetching/,
    ],
    [
      "three's REVISION is missing (format drift)",
      () => fakeProject({}, { [`.next/${chunk('scene')}`]: `x="${SCENE_FEATURE}"` }),
      /REVISION not found/,
    ],
    [
      'three is bundled twice',
      () => fakeProject({}, { [`.next/${chunk('other')}`]: THREE }),
      /three is bundled more than once/,
    ],
    [
      'a boot island cannot be found',
      () => fakeProject({}, { [`.next/${chunk('island0')}`]: noisyChunk(11) }),
      /boot island src\/components\/welcome\/WelcomeGate\.tsx/,
    ],
    ['the base geo body is missing', without('.next/server/app/geo/base.body'), /geo\/base\.body/],
    [
      'the base geo body is not the base geo',
      () => fakeProject({}, { '.next/server/app/geo/base.body': '{"format":"x"}' }),
      /not the base geo JSON/,
    ],
  ])('exits non-zero when %s', (_label, project, message) => {
    const result = runBudget(project())
    expect(result.stderr).toMatch(message)
    expect(result.status).toBe(1)
  })

  it('reports the apartment chunk on its own and fails when it is over its limit', () => {
    const result = runBudget(fakeProject())
    expect(result.stdout).toMatch(
      /^PASS Apartment chunk JS[^\n]*\n {2}1 chunks: static\/chunks\/room\.js$/m,
    )
    const over = runBudget(fakeProject({ apartmentChunkJsGzKB: 1 }))
    expect(over.stdout).toMatch(/^FAIL Apartment chunk JS/m)
    expect(over.status).toBe(1)
  })

  it('exits non-zero when no lazy chunk renders the apartment marker', () => {
    const result = runBudget(fakeProject({}, { [`.next/${chunk('room')}`]: noisyChunk(13) }))
    expect(result.stderr).toMatch(/cc-feature:apartment-scene/)
    expect(result.status).toBe(1)
  })

  it('reports the service worker and its precache, and fails either over its limit', () => {
    const result = runBudget(fakeProject())
    expect(result.stdout).toMatch(/^PASS Service worker/m)
    expect(result.stdout).toMatch(/^PASS Precache \(install\)[^\n]*\n {2}11 entries$/m)
    const over = runBudget(fakeProject({ serviceWorkerGzKB: 0.001, precacheGzKB: 1 }))
    expect(over.stdout).toMatch(/^FAIL Service worker/m)
    expect(over.stdout).toMatch(/^FAIL Precache/m)
    expect(over.status).toBe(1)
  })

  describe('service worker precache contents (S04e)', () => {
    const SW = '.next/server/app/serwist/sw.js.body'

    it.each([
      ['a model', '/models/taxi.low.752dce5e.glb'],
      ['audio', '/audio/music/a.webm'],
      ['a source map', '/_next/static/chunks/main.js.map'],
      ['an API route', '/api/save'],
      ['the moderator area', '/mod'],
    ])('exits non-zero when it precaches %s', (_label, url) => {
      const root = fakeProject({}, { [SW]: workerBody(PLAYABLE_CHUNKS, [url]) })
      // The forbidden file exists, so the failure is the policy, not a missing file.
      const file = url.startsWith('/_next/')
        ? join(root, '.next', url.slice('/_next/'.length))
        : join(root, 'public', url)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'x')
      const result = runBudget(root)
      expect(result.stderr).toMatch(new RegExp(`precaches ${url.replace(/[.?]/g, '\\$&')}`))
      expect(result.status).toBe(1)
    })

    it('exits non-zero when a file on the path to playable is not precached', () => {
      const without = PLAYABLE_CHUNKS.filter((name) => name !== 'scene')
      const result = runBudget(fakeProject({}, { [SW]: workerBody(without) }))
      expect(result.stderr).toMatch(/does not precache static\/chunks\/scene\.js/)
      expect(result.status).toBe(1)
    })

    it('exits non-zero when the versioned base geo is not precached', () => {
      const body = workerBody(PLAYABLE_CHUNKS).replace('/geo/base?v=0123456789ab', '/geo/base')
      const result = runBudget(fakeProject({}, { [SW]: body }))
      expect(result.stderr).toMatch(/versioned base geo/)
      expect(result.status).toBe(1)
    })

    it('reports the tier-warm lists and fails when a tier has none', () => {
      const ok = runBudget(withDistricts(fakeProject()))
      expect(ok.stdout).toMatch(/^INFO Tier warm: low 2 URLs, mid 2 URLs, high 2 URLs$/m)
      const root = withDistricts(fakeProject({}, { [SW]: workerBody(PLAYABLE_CHUNKS, [], false) }))
      const result = runBudget(root)
      expect(result.stderr).toMatch(/no tier-warm URLs for low, mid, high/)
      expect(result.status).toBe(1)
    })
  })

  describe('--perf limits override (positive control)', () => {
    it('fails every budget whose override limit is below the measured size', () => {
      const root = fakeProject()
      const tight = {
        ...DEFAULT_PERF,
        shellJsGzKB: 1,
        sceneChunkJsGzKB: 1,
        totalJsToPlayableGzKB: 1,
        baseGeoGzKB: 0.01,
        apartmentChunkJsGzKB: 1,
        serviceWorkerGzKB: 0.01,
        precacheGzKB: 1,
      }
      writeFileSync(join(root, 'tight.json'), JSON.stringify(tight))
      const result = runBudget(root, ['--perf=tight.json'])
      expect(result.stdout).toMatch(/^NOTE limits read from tight\.json, not perf\.json$/m)
      for (const name of [
        'Shell JS',
        '3D chunk JS',
        'Apartment chunk JS',
        'Total JS to playable',
        'Base geo',
        'Service worker',
        'Precache',
      ]) {
        expect(result.stdout).toMatch(new RegExp(`^FAIL ${name}`, 'm'))
      }
      expect(result.status).toBe(1)
      // perf.json was not touched, and the same build passes against it.
      expect(runBudget(root).status).toBe(0)
    })

    it('exits non-zero when the override file is missing or invalid', () => {
      const root = fakeProject()
      const missing = runBudget(root, ['--perf=nope.json'])
      expect(missing.stderr).toMatch(/No limits file/)
      expect(missing.status).toBe(1)
      writeFileSync(join(root, 'bad.json'), JSON.stringify({ shellJsGzKB: 1 }))
      const bad = runBudget(root, ['--perf=bad.json'])
      expect(bad.stderr).toMatch(/invalid or missing/)
      expect(bad.status).toBe(1)
    })
  })

  describe('district buildings', () => {
    it('checks each tier once the build has them', () => {
      const result = runBudget(withDistricts(fakeProject()))
      for (const tier of ['low', 'mid', 'high']) {
        expect(result.stdout).toMatch(new RegExp(`^PASS District buildings \\(${tier}\\)`, 'm'))
      }
      expect(result.stdout).not.toMatch(/^SKIP/m)
      expect(result.status).toBe(0)
    })

    it('fails a tier over its limit', () => {
      const tight = { districtBuildingsGzKB: { low: 1, mid: 300, high: 400 } }
      const result = runBudget(withDistricts(fakeProject(tight)))
      expect(result.stdout).toMatch(/^FAIL District buildings \(low\)/m)
      expect(result.stdout).toMatch(/^PASS District buildings \(mid\)/m)
      expect(result.status).toBe(1)
    })

    it('fails loudly when a tier has no district bodies', () => {
      const result = runBudget(withDistricts(fakeProject(), ['low', 'high']))
      expect(result.stderr).toMatch(/no mid district bodies/)
      expect(result.status).toBe(1)
    })
  })

  it('prints the model lines and fails when the glTF loader reaches the shell', () => {
    const clean = runBudget(fakeProject())
    expect(clean.stdout).toMatch(/^PASS Models on the playable path \(low\)/m)
    expect(clean.stdout).toMatch(/^PASS Model loader stays out of the shell JS/m)

    const leaky = runBudget(
      fakeProject(
        {},
        {
          '.next/server/app/index.html':
            '<html><body><script src="/_next/static/chunks/main.js" async=""></script><script>x="EXT_meshopt_compression"</script></body></html>',
        },
      ),
    )
    expect(leaky.stdout).toMatch(/^FAIL Model loader reached the shell JS/m)
    expect(leaky.status).toBe(1)
  })

  it('passes when the optional chunks exist and are not precached (PERF-7)', () => {
    const result = runBudget(fakeProject())
    expect(result.stdout).toMatch(/^PASS Optional chunks left out of the precache \(PERF-7\)/m)
  })

  it('fails when an optional chunk is precached, or when a marker is in no chunk (PERF-7)', () => {
    const precached = runBudget(
      fakeProject(
        {},
        {
          '.next/server/app/serwist/sw.js.body': workerBody([...PLAYABLE_CHUNKS, 'model-runtime']),
        },
      ),
    )
    expect(precached.stdout).toMatch(
      /^FAIL Optional chunks \(PERF-7\): precaches static\/chunks\/model-runtime\.js/m,
    )
    expect(precached.status).toBe(1)

    const missing = runBudget(fakeProject({}, { [`.next/${chunk('mod-console')}`]: 'x=1' }))
    expect(missing.stdout).toMatch(
      /^FAIL Optional chunks \(PERF-7\): no built chunk carries the mod-console marker/m,
    )
    expect(missing.status).toBe(1)
  })
})
