/**
 * Static import graph of the source tree, for guard tests (src/lib/shell-boundary.test.ts,
 * src/lib/copy/key-usage.test.ts). Node-only test helper: never import it from app code.
 *
 * Only static runtime imports are edges: `import type` / `export type` are erased, and
 * `import()` is the lazy boundary (the code behind it loads in its own chunk).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '../../..')
export const SRC = join(ROOT, 'src')
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'] as const

const isTest = (file: string) => /\.(test|spec)\.[jt]sx?$/.test(file)

/** Repo-relative path with forward slashes. */
export function rel(file: string): string {
  return relative(ROOT, file).split('\\').join('/')
}

/** Every non-test source file under `dir`. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !isTest(file))
}

// Between the keyword and `from` only bindings may appear (names, `*`, `as`, braces, commas),
// so a declaration such as `export type X = ...` can never swallow a later import.
const STATIC_IMPORT =
  /^[ \t]*(?:import|export)\s+(type\s+)?(?:[\w$*\s{},]*?\sfrom\s+)?['"]([^'"]+)['"]/gm

/** Static runtime module specifiers of a file, in source order. */
export function staticSpecifiers(code: string): string[] {
  const specs: string[] = []
  for (const match of code.matchAll(STATIC_IMPORT)) {
    if (match[1] === undefined && match[2] !== undefined) specs.push(match[2])
  }
  return specs
}

/** Resolves a local specifier (`@/`, `@data/`, relative) to a file; undefined for packages. */
export function resolveLocal(spec: string, from: string): string | undefined {
  let base: string
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
  else if (spec.startsWith('@data/')) base = join(ROOT, 'data', spec.slice(6))
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else return undefined
  const candidates = [base, ...EXTENSIONS.map((ext) => base + ext)]
  candidates.push(...EXTENSIONS.map((ext) => join(base, `index${ext}`)))
  return candidates.find((file) => statSync(file, { throwIfNoEntry: false })?.isFile())
}

const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/

/** True for a `'use client'` module. */
export function isClientModule(code: string): boolean {
  return USE_CLIENT.test(code)
}

const isScript = (file: string) => /\.[cm]?[jt]sx?$/.test(file)

export interface ImportClosure {
  /** Local files reached (scripts and JSON). */
  readonly files: Set<string>
  /** Package specifiers reached, with the first file that imports each. */
  readonly packages: Map<string, string>
}

/** Everything statically reachable from `entries` (entries included). */
export function staticClosure(entries: readonly string[]): ImportClosure {
  const files = new Set<string>()
  const packages = new Map<string, string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || files.has(file)) continue
    files.add(file)
    if (!isScript(file)) continue
    for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
      const target = resolveLocal(spec, file)
      if (target === undefined) {
        if (!spec.startsWith('.') && !spec.startsWith('@/') && !packages.has(spec)) {
          packages.set(spec, file)
        }
        continue
      }
      queue.push(target)
    }
  }
  return { files, packages }
}

/**
 * The client part of a route: everything statically reachable from a `'use client'` module that
 * the route's server modules (`entries`) import, directly or through other server modules.
 * Server-only modules are walked to find those boundaries but are not part of the result.
 */
export function clientClosure(entries: readonly string[]): ImportClosure {
  const boundaries: string[] = []
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || seen.has(file) || !isScript(file)) continue
    seen.add(file)
    const code = readFileSync(file, 'utf8')
    if (isClientModule(code)) {
      boundaries.push(file)
      continue
    }
    for (const spec of staticSpecifiers(code)) {
      const target = resolveLocal(spec, file)
      if (target !== undefined) queue.push(target)
    }
  }
  return staticClosure(boundaries)
}
