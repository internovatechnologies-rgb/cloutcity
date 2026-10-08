/**
 * Server code stays on the server (S18b part 2, RISK-5):
 *  - every module under src/server starts with `import 'server-only'` (the build fails if a
 *    client module imports one);
 *  - no browser code reaches src/server, statically or through `import()`;
 *  - the game route `/` reaches no /mod module (its console, its session client) even lazily,
 *    and no browser module names MODERATOR_EMAILS or the service-role key.
 * scripts/shell-guard.ts checks the built chunks for the same names.
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
} from './testing/importGraph'

const SERVER_DIR = join(SRC, 'server')

/** Static and dynamic local imports of a file. */
function runtimeTargets(file: string): string[] {
  const code = readFileSync(file, 'utf8')
  const specs = staticSpecifiers(code)
  for (const match of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1] !== undefined) specs.push(match[1])
  }
  return specs.flatMap((spec) => {
    const target = resolveLocal(spec, file)
    return target === undefined ? [] : [target]
  })
}

/** Every module reachable from `entries`, through static and dynamic imports. */
function fullClosure(entries: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    queue.push(...runtimeTargets(file))
  }
  return seen
}

const browserEntries = sourceFiles(SRC).filter(
  (file) =>
    isClientModule(readFileSync(file, 'utf8')) ||
    rel(file).startsWith('src/state/') ||
    rel(file).startsWith('src/components/'),
)

describe('server boundary (S18b part 2)', () => {
  it('every src/server module imports server-only first', () => {
    const files = sourceFiles(SERVER_DIR)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
      expect(staticSpecifiers(code)[0], rel(file)).toBe('server-only')
    }
  })

  it('no browser module reaches src/server, even through import()', () => {
    const reached = [...fullClosure(browserEntries)].map(rel)
    expect(reached.filter((file) => file.startsWith('src/server/'))).toEqual([])
  })

  it('the game route reaches no /mod module, even lazily', () => {
    const reached = [...fullClosure([join(SRC, 'app/page.tsx'), join(SRC, 'app/layout.tsx')])].map(
      rel,
    )
    expect(reached).toContain('src/components/profile/MePanel.tsx')
    expect(
      reached.filter(
        (file) =>
          file.startsWith('src/components/mod/') ||
          file.startsWith('src/app/mod/') ||
          file === 'src/lib/supabase/modAuth.ts' ||
          file.startsWith('src/server/'),
      ),
    ).toEqual([])
  })

  it('no browser module names MODERATOR_EMAILS or the service-role key', () => {
    const named = [...fullClosure(browserEntries)]
      .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
      .filter((file) =>
        /MODERATOR_EMAILS|SUPABASE_SERVICE_ROLE_KEY/.test(readFileSync(file, 'utf8')),
      )
      .map(rel)
    expect(named).toEqual([])
  })
})
