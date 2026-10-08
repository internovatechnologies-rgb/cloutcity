/**
 * The handle rules exist twice, in TypeScript (src/lib/handles, src/lib/forms/handle.ts) and in
 * the S18a migration. These checks read the migration's SQL and fail when the two drift apart.
 * The integration suite (tests/integration/handles.test.ts) runs both on the same handles.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { balance } from '@/lib/data/config'
import { HANDLE_PATTERN } from '@/lib/forms/handle'
import { RPC_ERRORS } from '@/lib/supabase/attestation'
import { handleSkeleton } from './normalise'

const MIGRATIONS = resolve(import.meta.dirname, '../../../supabase/migrations')
const migrationFiles = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
const s18a = migrationFiles.find((name) => name.endsWith('_s18a_handles_profile.sql'))
const sql = readFileSync(join(MIGRATIONS, s18a ?? ''), 'utf8')

/** The body of one SQL function in the migration. */
function functionBody(name: string): string {
  const start = sql.indexOf(`create function ${name}(`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  const open = sql.indexOf('$$', start)
  return sql.slice(open + 2, sql.indexOf('$$', open + 2))
}

describe('S18a migration ↔ TypeScript', () => {
  it('finds the migration', () => {
    expect(s18a).toBeDefined()
  })

  it('handle_format_ok uses HANDLE_PATTERN, built from data/config/handles.json', () => {
    const literal = /p_handle ~ '([^']+)'/.exec(functionBody('private.handle_format_ok'))?.[1]
    expect(literal).toBe(HANDLE_PATTERN.source)
  })

  it('handle_skeleton maps the same digits to the same letters and drops underscores', () => {
    const match = /translate\(lower\(p_handle\), '([^']+)', '([^']+)'\)/.exec(
      functionBody('private.handle_skeleton'),
    )
    const from = match?.[1] ?? ''
    const to = match?.[2] ?? ''
    expect(from.length).toBe(to.length + 1)
    expect(from.at(-1)).toBe('_')
    for (const [i, digit] of [...from.slice(0, -1)].entries()) {
      expect(handleSkeleton(digit), digit).toBe(to[i])
    }
    for (const digit of '0123456789') {
      if (!from.includes(digit)) expect(handleSkeleton(digit)).toBe(digit)
    }
  })

  it('handle_key and handle_squeeze match handleKey and squeezeRepeats', () => {
    expect(functionBody('private.handle_key')).toContain("lower(replace(p_handle, '_', ''))")
    expect(functionBody('private.handle_squeeze')).toContain(
      "regexp_replace(p_text, '(.)\\1+', '\\1', 'g')",
    )
  })

  it('public_level allows exactly the clout ladder ids (data/config/balance.json)', () => {
    const check = /public_level in \(([^)]+)\)/.exec(sql)?.[1] ?? ''
    const ids = [...check.matchAll(/'([^']+)'/g)].map((match) => match[1])
    expect(ids).toEqual(balance.clout.levels.map((level) => level.id))
  })

  it('every client-facing error code any migration raises is in RPC_ERRORS', () => {
    const codes = new Set<string>()
    for (const file of migrationFiles) {
      const text = readFileSync(join(MIGRATIONS, file), 'utf8')
      for (const match of text.matchAll(/raise exception '([a-z_]+)' using errcode = 'PT\d{3}'/g)) {
        if (match[1] !== undefined) codes.add(match[1])
      }
    }
    expect(codes.size).toBeGreaterThan(0)
    expect([...codes].filter((code) => !(RPC_ERRORS as readonly string[]).includes(code))).toEqual(
      [],
    )
  })
})
