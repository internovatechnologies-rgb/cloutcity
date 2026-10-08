/**
 * `npm run assets:build` as a real child process: bad flags fail fast, `--check --offline`
 * rebuilds byte-identically from the cache without the network and leaves perf.json alone, and a
 * tampered output is caught.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CACHE_DIR,
  MANIFEST_PATH,
  buildAssets,
  differingOutputs,
  readSourcesLock,
} from './build.ts'

const ROOT = join(import.meta.dirname, '../..')
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/assets/build.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

const lock = await readSourcesLock()
const cacheValid =
  lock !== undefined &&
  lock.sources.every((source) =>
    source.files.every((file) => {
      const path =
        source.files.length === 1 && file.path.endsWith('.zip')
          ? join(CACHE_DIR, file.path)
          : join(CACHE_DIR, source.id, ...file.path.split('/'))
      return existsSync(path) && sha(path) === file.sha256
    }),
  )

describe('assets:build CLI', () => {
  it.each([
    [['--bogus'], /Unknown option --bogus/],
    [['--update', '--check'], /--update cannot be combined/],
    [['--offline', '--update'], /--update cannot be combined/],
  ])('%j exits 1 before doing anything', (args, message) => {
    const result = run(...args)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(message)
    expect(result.stdout).not.toMatch(/download|built /)
  })

  it.skipIf(!cacheValid)(
    '--check --offline rebuilds byte-identically from the cache and leaves perf.json alone',
    () => {
      const perf = join(ROOT, 'data/config/perf.json')
      const before = sha(perf)
      const result = run('--check', '--offline')
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('check: committed model outputs match a rebuild')
      expect(result.stdout).not.toMatch(/^download /m)
      expect(sha(perf)).toBe(before)
    },
    120_000,
  )

  it.skipIf(!cacheValid)(
    'flags a tampered model file and a tampered manifest',
    async () => {
      const result = await buildAssets('offline', () => undefined)
      expect(await differingOutputs(result)).toEqual([])
      const first = [...result.models][0]
      if (first === undefined) throw new Error('no models built')
      const [modelPath, bytes] = first
      const tamperedModel = new Map(result.models)
      tamperedModel.set(
        modelPath,
        Uint8Array.from(bytes, (b, i) => (i === 100 ? b ^ 1 : b)),
      )
      const texts = new Map(result.texts)
      texts.set(MANIFEST_PATH, `${texts.get(MANIFEST_PATH)} `)
      const differing = await differingOutputs({ ...result, models: tamperedModel, texts })
      expect(differing).toEqual([
        MANIFEST_PATH.replace(`${ROOT}/`, ''),
        modelPath.replace(`${ROOT}/`, ''),
      ])
    },
    120_000,
  )
})
