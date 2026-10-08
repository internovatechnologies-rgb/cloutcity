/**
 * RISK-5 (S18c): src/server holds the service-role key and save validation. Every module there
 * starts with `import 'server-only'` (a build error if a client bundle ever pulls it in), and no
 * browser code reaches it: from every `'use client'` module, src/state/ and src/components/,
 * neither static imports nor lazy `import()` lead into src/server.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SRC,
  isClientModule,
  rel,
  resolveLocal,
  sourceFiles,
  staticSpecifiers,
} from '@/lib/testing/importGraph'

const SERVER = join(SRC, 'server')
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

/** Every local file reachable from `entries` through static imports and `import()`. */
function reachable(entries: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    const code = readFileSync(file, 'utf8')
    const specs = [
      ...staticSpecifiers(code),
      ...[...code.matchAll(DYNAMIC_IMPORT)].map((match) => match[1] ?? ''),
    ]
    for (const spec of specs) {
      const target = resolveLocal(spec, file)
      if (target !== undefined) queue.push(target)
    }
  }
  return seen
}

describe('src/server stays on the server (RISK-5)', () => {
  const serverFiles = sourceFiles(SERVER)

  it('finds the server modules', () => {
    expect(serverFiles.map(rel)).toEqual(
      expect.arrayContaining([
        'src/server/supabase/service.ts',
        'src/server/saves/handleUpload.ts',
        'src/server/saves/ceilings.ts',
        'src/server/saves/supabaseBackend.ts',
      ]),
    )
  })

  it("every server module imports 'server-only' first", () => {
    const missing = serverFiles.filter((file) => {
      const specs = staticSpecifiers(readFileSync(file, 'utf8'))
      return specs[0] !== 'server-only'
    })
    expect(missing.map(rel)).toEqual([])
  })

  it('no browser code reaches src/server, statically or lazily', () => {
    const entries = sourceFiles(SRC).filter((file) => {
      const path = rel(file)
      return (
        path.startsWith('src/state/') ||
        path.startsWith('src/components/') ||
        isClientModule(readFileSync(file, 'utf8'))
      )
    })
    expect(entries.length).toBeGreaterThan(10)
    const leaks = [...reachable(entries)].filter((file) => file.startsWith(`${SERVER}/`))
    expect(leaks.map(rel)).toEqual([])
  })

  it('the walker follows lazy imports (self-check)', () => {
    const sync = join(SRC, 'state/session.ts')
    expect([...reachable([sync])].map(rel)).toContain('src/state/cloudSync.ts')
  })

  it('no NEXT_PUBLIC_ variable names the service-role key', () => {
    for (const file of sourceFiles(SRC)) {
      expect(readFileSync(file, 'utf8'), rel(file)).not.toMatch(/NEXT_PUBLIC_\w*SERVICE/)
    }
  })
})
