import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')

describe('generated database types', () => {
  it('src/lib/supabase/database.types.ts matches the migrated schema (run `npm run db:types`)', async () => {
    const { stdout } = await promisify(execFile)(
      join(ROOT, 'node_modules', '.bin', 'supabase'),
      ['gen', 'types', '--local', '--schema', 'public'],
      { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 },
    )
    const committed = readFileSync(join(ROOT, 'src/lib/supabase/database.types.ts'), 'utf8')
    expect(stdout).toBe(committed)
  })
})
