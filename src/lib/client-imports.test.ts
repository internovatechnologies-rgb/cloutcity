/**
 * Guard for the shell JS budget: classic `zod` (and the loaders that run it at import time)
 * must never be reachable from browser code. Client code validates with `zod/mini` instead.
 *
 * Browser entry points are every `'use client'` module plus everything under src/state/. The
 * test follows their runtime imports (type-only imports are erased, so they are skipped) and
 * fails if any reachable module imports `zod` or a classic-zod module under src/lib/data/.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')
const SRC = join(ROOT, 'src')
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']

const isTest = (file: string) => /\.(test|spec)\.[jt]sx?$/.test(file)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !isTest(file))
}

/** Static runtime imports/re-exports in a file (not `import type`): they land in the same chunk. */
function staticSpecifiers(code: string): string[] {
  const specs: string[] = []
  const staticImport =
    /^[ \t]*(?:import|export)\s+(type\s+)?(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm
  for (const match of code.matchAll(staticImport)) {
    if (match[1] === undefined && match[2] !== undefined) specs.push(match[2])
  }
  return specs
}

/** Runtime module specifiers in a file: static imports/re-exports (not `import type`) and dynamic imports. */
function runtimeSpecifiers(code: string): string[] {
  const specs = staticSpecifiers(code)
  for (const match of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1] !== undefined) specs.push(match[1])
  }
  return specs
}

function resolveLocal(spec: string, from: string): string | undefined {
  let base: string
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
  else if (spec.startsWith('@data/')) base = join(ROOT, 'data', spec.slice(6))
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else return undefined
  const candidates = [base, ...EXTENSIONS.map((ext) => base + ext)]
  candidates.push(...EXTENSIONS.map((ext) => join(base, `index${ext}`)))
  return candidates.find((file) => statSync(file, { throwIfNoEntry: false })?.isFile())
}

/**
 * Modules that pull classic zod into whatever imports them. geo.ts also inlines ~430 KB of
 * derived geo JSON; the scene must fetch those layers as static assets instead. Anything under
 * data/moderation/ (the handle blocklist, S18a) is server data: shipping it would hand players
 * the list of words the filter looks for.
 */
const FORBIDDEN_LOCAL =
  /^(?:src\/lib\/data\/(config|content|geo|parse|schemas\/.*)\.ts|data\/moderation\/.*)$/

function violations(entries: readonly string[]): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || seen.has(file) || !/\.[cm]?[jt]sx?$/.test(file)) continue
    seen.add(file)
    const rel = relative(ROOT, file)
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec === 'zod' || spec.startsWith('zod/v4') || spec === 'zod/v3') {
        found.push(`${rel} imports '${spec}'`)
        continue
      }
      const target = resolveLocal(spec, file)
      if (target === undefined) continue
      const targetRel = relative(ROOT, target)
      if (FORBIDDEN_LOCAL.test(targetRel)) found.push(`${rel} imports ${targetRel}`)
      queue.push(target)
    }
  }
  return found
}

/**
 * The Supabase client (~50 KB gzipped) must load lazily: browser code reaches it only through a
 * dynamic `import()`, never a static import chain from an entry point.
 */
const SUPABASE_PACKAGE = /^@supabase\//

function staticSupabaseImports(entries: readonly string[]): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || seen.has(file) || !/\.[cm]?[jt]sx?$/.test(file)) continue
    seen.add(file)
    for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
      if (SUPABASE_PACKAGE.test(spec)) {
        found.push(`${relative(ROOT, file)} statically imports '${spec}'`)
        continue
      }
      const target = resolveLocal(spec, file)
      if (target !== undefined) queue.push(target)
    }
  }
  return found
}

const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/

describe('browser code stays off classic zod (shell JS budget)', () => {
  const clientEntries = sourceFiles(SRC).filter(
    (file) =>
      USE_CLIENT.test(readFileSync(file, 'utf8')) || relative(SRC, file).startsWith('state/'),
  )

  it('finds the client entry points', () => {
    expect(clientEntries.map((file) => relative(ROOT, file))).toEqual(
      expect.arrayContaining(['src/components/nav/BottomTabs.tsx', 'src/state/store.ts']),
    )
  })

  it('no client-reachable module imports zod classic or a classic-zod data loader', () => {
    expect(violations(clientEntries)).toEqual([])
  })

  it('no client entry point statically reaches @supabase/* (load it with import())', () => {
    expect(staticSupabaseImports(clientEntries)).toEqual([])
  })

  it('the Supabase import scanner flags static imports only (self-check)', () => {
    const code = [
      "import { createClient } from '@supabase/supabase-js'",
      "import type { Session } from '@supabase/auth-js'",
      "const lazy = () => import('@supabase/supabase-js')",
    ].join('\n')
    expect(staticSpecifiers(code).filter((spec) => SUPABASE_PACKAGE.test(spec))).toEqual([
      '@supabase/supabase-js',
    ])
  })

  it('the client place layer (src/lib/world/places.ts) stays off classic zod and geo.ts', () => {
    expect(violations([join(SRC, 'lib/world/places.ts')])).toEqual([])
  })

  it('the forbidden list covers every classic-zod data loader, geo.ts included', () => {
    for (const file of [
      'src/lib/data/config.ts',
      'src/lib/data/content.ts',
      'src/lib/data/geo.ts',
      'src/lib/data/parse.ts',
      'src/lib/data/schemas/world.ts',
    ]) {
      expect(FORBIDDEN_LOCAL.test(file), file).toBe(true)
    }
    expect(FORBIDDEN_LOCAL.test('src/lib/data/geometry.ts')).toBe(false)
  })

  it('the forbidden list covers the handle blocklist and its loaders (S18a)', () => {
    for (const file of [
      'data/moderation/handle-blocklist.json',
      'src/lib/data/schemas/handles.ts',
    ]) {
      expect(FORBIDDEN_LOCAL.test(file), file).toBe(true)
    }
    expect(FORBIDDEN_LOCAL.test('data/config/handles.json')).toBe(false)
    expect(FORBIDDEN_LOCAL.test('src/lib/handles/filter.ts')).toBe(false)
  })

  it('a client module importing the blocklist is caught (self-check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-imports-probe-'))
    try {
      const probe = join(dir, 'probe.ts')
      writeFileSync(probe, "import list from '@data/moderation/handle-blocklist.json'\n")
      expect(violations([probe])).toEqual([
        `${relative(ROOT, probe)} imports data/moderation/handle-blocklist.json`,
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the import scanner sees what it must (self-check)', () => {
    const code = [
      "import { z } from 'zod'",
      "import type { X } from '@/lib/data/config'",
      'import {',
      '  a,',
      "} from './multi'",
      "export { b } from './reexport'",
      "import './side-effect'",
      "const lazy = () => import('./lazy')",
    ].join('\n')
    expect(runtimeSpecifiers(code)).toEqual([
      'zod',
      './multi',
      './reexport',
      './side-effect',
      './lazy',
    ])
  })
})

/**
 * `import { z } from 'zod/mini'` binds the whole namespace object, which the bundler cannot
 * tree-shake, so it pulls every zod/mini check into the shell (~92 KB). `import * as z` lets
 * unused checks drop out. Type-only imports are erased and allowed.
 */
const NAMED_Z_FROM_MINI = /^[ \t]*import\s*\{[^}]*\bz\b[^}]*\}\s*from\s*['"]zod\/mini['"]/m

const CLIENT_DIRS = ['components', 'state', 'lib', 'engine', 'scene'] as const

function clientReachableFiles(): string[] {
  const files: string[] = []
  for (const dir of CLIENT_DIRS) {
    const path = join(SRC, dir)
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) files.push(...sourceFiles(path))
  }
  // src/app: only client components run in the browser.
  files.push(
    ...sourceFiles(join(SRC, 'app')).filter((file) => USE_CLIENT.test(readFileSync(file, 'utf8'))),
  )
  return files
}

describe('browser code imports zod/mini as a namespace (shell JS budget)', () => {
  it('the named-z matcher sees what it must (self-check)', () => {
    expect(NAMED_Z_FROM_MINI.test("import { z } from 'zod/mini'")).toBe(true)
    expect(NAMED_Z_FROM_MINI.test('import { z } from "zod/mini"')).toBe(true)
    expect(NAMED_Z_FROM_MINI.test("import { safeParse, z } from 'zod/mini'")).toBe(true)
    expect(NAMED_Z_FROM_MINI.test("import * as z from 'zod/mini'")).toBe(false)
    expect(NAMED_Z_FROM_MINI.test("import type { z } from 'zod/mini'")).toBe(false)
    expect(NAMED_Z_FROM_MINI.test("import { z } from 'zod'")).toBe(false)
  })

  it('no client-reachable module uses `import { z } from "zod/mini"`', () => {
    const offenders = clientReachableFiles()
      .filter((file) => NAMED_Z_FROM_MINI.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file))
    expect(offenders).toEqual([])
  })
})
