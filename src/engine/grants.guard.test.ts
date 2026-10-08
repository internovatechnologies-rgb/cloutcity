/**
 * Guards for S15's one-grant-function rule (CLAUDE.md "Grants"):
 * - only src/engine/grants.ts writes clout with the `grant` source, so every grant is keyed,
 *   capped and logged;
 * - goals, grants and prestige import nothing from Supabase (grants stay local until S18c
 *   re-validates them through `toServerGrantRow`), not even through another module.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SRC, rel, sourceFiles, staticClosure } from '@/lib/testing/importGraph'

/** A `source: 'grant'` (or "grant") property in code: a clout change from the grant source. */
const GRANT_SOURCE = /\bsource\s*:\s*['"`]grant['"`]/

describe('one grant function', () => {
  it('only src/engine/grants.ts records grant clout', () => {
    const writers = sourceFiles(SRC).filter((file) => GRANT_SOURCE.test(readFileSync(file, 'utf8')))
    expect(writers.map(rel)).toEqual(['src/engine/grants.ts'])
  })

  it('the scan sees a grant write (self-check)', () => {
    expect(GRANT_SOURCE.test("recordClout(s, { source: 'grant', amount: 5 }, c)")).toBe(true)
    expect(GRANT_SOURCE.test('{ source:"grant" }')).toBe(true)
    expect(GRANT_SOURCE.test("{ source: 'grants' }")).toBe(false)
  })

  it('goals, grants and prestige reach no Supabase module or package', () => {
    const entries = ['goals.ts', 'grants.ts', 'prestige.ts'].map((file) =>
      join(SRC, 'engine', file),
    )
    const closure = staticClosure(entries)
    expect([...closure.files].map(rel).filter((path) => /supabase/i.test(path))).toEqual([])
    expect([...closure.packages.keys()].filter((spec) => /supabase/i.test(spec))).toEqual([])
  })
})
