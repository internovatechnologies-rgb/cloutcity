/**
 * The safety rules exist twice, in TypeScript (src/lib/safety, data/config/moderation.json) and in
 * the S18b migrations. These checks read the migrations' SQL and fail when the two drift apart.
 * The integration suite (tests/integration/safety.test.ts) runs both on the same inputs.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import blocklistJson from '@data/moderation/handle-blocklist.json'
import { describe, expect, it } from 'vitest'
import { HandleBlocklistSchema } from '@/lib/data/schemas/handles'
import { flattenBlocklist, handleAllowed } from '@/lib/handles/filter'
import {
  HANDLE_REPORT_REASONS,
  HELD_HANDLE_PLACEHOLDER,
  NOTICE_KINDS,
  REPORT_KINDS,
  REPORT_REASONS,
} from './reports'
import { CONTACT_PATTERNS, HIDDEN_CHARS_PATTERN, WHITESPACE_PATTERN } from './textFilter'

const MIGRATIONS = resolve(import.meta.dirname, '../../../supabase/migrations')
const read = (suffix: string) => {
  const file = readdirSync(MIGRATIONS).find((name) => name.endsWith(suffix))
  expect(file, suffix).toBeDefined()
  return readFileSync(join(MIGRATIONS, file ?? ''), 'utf8')
}
const safety = read('_s18b_safety.sql')
const moderation = read('_s18b_moderation.sql')

/** The body of one SQL function. */
function functionBody(sql: string, name: string): string {
  const start = sql.search(
    new RegExp(`create (or replace )?function ${name.replace('.', '\\.')}\\(`),
  )
  expect(start, name).toBeGreaterThanOrEqual(0)
  const open = sql.indexOf('$$', start)
  return sql.slice(open + 2, sql.indexOf('$$', open + 2))
}

/** Every quoted word inside the first `<column> in (...)` after `anchor`. */
function inList(sql: string, anchor: string): string[] {
  const at = sql.indexOf(anchor)
  expect(at, anchor).toBeGreaterThanOrEqual(0)
  const list = /in \(([^)]*)\)/.exec(sql.slice(at))?.[1] ?? ''
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '')
}

describe('S18b migrations ↔ TypeScript', () => {
  it('contains_contact_info uses the same hidden-character class and patterns, in order', () => {
    const body = functionBody(safety, 'private.contains_contact_info')
    expect(body).toContain(`p_text ~ '${HIDDEN_CHARS_PATTERN}'`)
    const patterns = [...body.matchAll(/^ {8}'(.+)',?$/gm)].map((match) => match[1])
    expect(patterns).toEqual([...CONTACT_PATTERNS])
  })

  it('normalize_text folds NFKC, ASCII case and the same whitespace', () => {
    const body = functionBody(safety, 'private.normalize_text')
    expect(body).toContain('normalize(p_text, NFKC)')
    expect(body).toContain("'ABCDEFGHIJKLMNOPQRSTUVWXYZ'")
    expect(body).toContain(`'${WHITESPACE_PATTERN}'`)
  })

  it('every reason list in SQL is REPORT_REASONS, and the handle subset is HANDLE_REPORT_REASONS', () => {
    for (const anchor of ['reason text not null check (reason', 'reason text check (reason']) {
      expect(inList(safety, anchor)).toEqual([...REPORT_REASONS])
    }
    expect(inList(safety, 'p_reason is null or p_reason not')).toEqual([...REPORT_REASONS])
    expect(inList(safety, "(p_kind = 'handle' and p_reason not")).toEqual([
      ...HANDLE_REPORT_REASONS,
    ])
    expect(inList(moderation, 'p_reason is null or p_reason not')).toEqual([...REPORT_REASONS])
  })

  it('report kinds and notice kinds match', () => {
    expect(inList(safety, "kind text not null check (kind in ('player'")).toEqual([...REPORT_KINDS])
    expect(inList(safety, 'create table public.account_notices')).toEqual([...NOTICE_KINDS])
  })

  it('public_handle shows HELD_HANDLE_PLACEHOLDER, which no player can ever choose', () => {
    expect(functionBody(safety, 'private.public_handle')).toContain(
      `then '${HELD_HANDLE_PLACEHOLDER}' else`,
    )
    const terms = flattenBlocklist(HandleBlocklistSchema.parse(blocklistJson))
    expect(handleAllowed(HELD_HANDLE_PLACEHOLDER, terms)).toBe(false)
    expect(handleAllowed(`${HELD_HANDLE_PLACEHOLDER}42`, terms)).toBe(false)
  })
})
