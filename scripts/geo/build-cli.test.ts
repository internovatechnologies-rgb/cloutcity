/**
 * `npm run geo:build` flag handling, as a real child process: bad flags fail fast with exit 1
 * and touch nothing; `--check --offline` against a valid cache passes without the network.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCache, readLock } from './build'

const ROOT = join(import.meta.dirname, '../..')
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/geo/build.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })

const lock = await readLock()
const cacheValid = lock !== undefined && (await readCache(lock)).valid

describe('geo:build CLI', () => {
  it.each([
    [['--bogus'], /Unknown option --bogus/],
    [['--check=1'], /Unknown option --check=1/],
    [['--update', '--check'], /--update cannot be combined/],
    [['--offline', '--update'], /--update cannot be combined/],
  ])('%j exits 1 before doing anything', (args, message) => {
    const result = run(...args)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(message)
    expect(result.stdout).not.toMatch(/download|cache /)
  })

  it.skipIf(!cacheValid)(
    '--check --offline rebuilds from the cache and matches the committed files',
    () => {
      const result = run('--check', '--offline')
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('check: committed geo files match a rebuild')
      expect(result.stdout).not.toMatch(/^download /m)
    },
    120_000,
  )
})
