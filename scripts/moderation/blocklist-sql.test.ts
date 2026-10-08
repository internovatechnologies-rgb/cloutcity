import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SEED_BEGIN, SEED_END, handleSeedSql, readSeedInputs } from './blocklist-sql'

const MIGRATIONS = resolve(import.meta.dirname, '../../supabase/migrations')

/** The newest migration that carries a handle seed block: the one the database ends up with. */
function newestSeed(): { file: string; block: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .reverse()
  for (const file of files) {
    const text = readFileSync(join(MIGRATIONS, file), 'utf8')
    const start = text.indexOf(SEED_BEGIN)
    if (start === -1) continue
    const end = text.indexOf(SEED_END, start)
    expect(end, `${file} has no end marker`).toBeGreaterThan(start)
    return { file, block: text.slice(start, end + SEED_END.length) }
  }
  throw new Error('no migration holds a handle seed block')
}

describe('handle seed (npm run handles:sql)', () => {
  const inputs = readSeedInputs()

  it('the newest seed in supabase/migrations equals the /data files', () => {
    const { file, block } = newestSeed()
    expect(block, `${file} is stale: run npm run handles:sql`).toBe(handleSeedSql(inputs))
  })

  it('writes every setting, word and term once', () => {
    const seed = handleSeedSql(inputs)
    const rows = seed.split('\n').filter((line) => line.startsWith('  ('))
    expect(new Set(rows).size).toBe(rows.length)
    expect(seed).toContain("('changes.perWindow', 2)")
    expect(seed).toContain("('rateLimits.checkHandle.max', 30)")
    expect(seed).toContain("('adjective', 'Bold')")
    expect(seed).toContain("('noun', 'Bodega')")
    expect(seed).toContain("('allow', 'badminton')")
    expect(seed).toContain("('exact', 'mod')")
    expect(seed).toContain("('contains', 'nypd')")
  })
})
