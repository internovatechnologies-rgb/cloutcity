/**
 * `npm run budget` (second step): the shell of `/` carries only the boot path (S05c, DEC-11).
 *
 * Reads the built `.next` the same way scripts/budget.ts does (the scripts the prerendered `/`
 * HTML runs, plus its inline scripts) and fails when:
 * - a shell chunk contains a feature marker: every feature root renders a literal
 *   `data-cc-feature="cc-feature:<id>"`, and the list of ids is read from src/;
 * - a shell chunk contains a copy key of a non-boot namespace (read from data/copy/),
 *   `$ZodType` (zod belongs in the boot islands, not the shell) or `signInAnonymously`
 *   (supabase-js belongs in its own lazy chunk, S05);
 * - any static chunk contains an e2e test-hook marker (hooks ship only in the `.next-e2e` test
 *   build; next.config.ts `NEXT_PUBLIC_TEST_HOOKS`) or a server-only name (MODERATOR_EMAILS,
 *   SUPABASE_SERVICE_ROLE_KEY);
 * - the shell is over `shellJsGzKB - shellHeadroomGzKB` (data/config/perf.json).
 *
 * Positive controls keep the scan honest: a boot copy key must be found in the shell, and every
 * feature marker in some non-shell chunk. Run after `npm run build`.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { PerfConfigSchema } from '../src/lib/data/schemas/config.ts'
import { extractScripts, gzipBytes, hasMarker, staticFilePath } from './budget.ts'

/**
 * Window properties the e2e test hooks install (src/components/{events,places}/*TestHook.ts,
 * src/scene/testHooks.tsx, src/lib/audio/testHook.ts).
 */
export const TEST_HOOK_MARKERS = ['__cloutcityTest', '__cloutcityPlaces'] as const

/**
 * Server-only names (S18b part 2, RISK-5): the moderator allowlist and the service-role key are
 * read by src/server on the Node runtime only, so no static chunk of the build may name them.
 */
export const SERVER_ONLY_MARKERS = ['MODERATOR_EMAILS', 'SUPABASE_SERVICE_ROLE_KEY'] as const

const MARKER = /cc-feature:[a-z0-9]+(?:-[a-z0-9]+)*/g
const ZOD_MARKER = '$ZodType'
/**
 * The anonymous sign-in (S05) lives in the lazy Supabase chunk, imported only after the 18+
 * attestation and once the map is playable; its method name in the shell would mean
 * supabase-js was bundled into it.
 */
export const SUPABASE_AUTH_MARKER = 'signInAnonymously'

export interface Chunk {
  /** Path relative to the build's `static/` directory, or `inline` for the inline scripts. */
  readonly name: string
  readonly text: string
}

export interface GuardInput {
  readonly shell: readonly Chunk[]
  /** Every other static JS chunk of the build. */
  readonly others: readonly Chunk[]
  /** Feature marker ids found in src (`cc-feature:<id>`). */
  readonly markers: readonly string[]
  readonly bootKeys: readonly string[]
  readonly featureKeys: readonly string[]
  readonly shellGzBytes: number
  readonly maxShellGzBytes: number
}

/** True when `key` appears as a whole string literal (any quote, JSON-escaped or not). */
function hasKeyLiteral(text: string, key: string): boolean {
  for (const quote of ['"', "'", '`', '\\"']) {
    if (text.includes(`${quote}${key}${quote}`)) return true
  }
  return false
}

/** Every failure of the boot-path rule, as readable lines. Empty when the build passes. */
export function shellGuardFailures(input: GuardInput): string[] {
  const failures: string[] = []
  for (const chunk of input.shell) {
    for (const marker of input.markers) {
      if (hasMarker(chunk.text, marker)) failures.push(`${chunk.name}: feature module ${marker}`)
    }
    const keys = input.featureKeys.filter((key) => hasKeyLiteral(chunk.text, key))
    if (keys.length > 0) {
      failures.push(
        `${chunk.name}: ${keys.length} feature copy key(s), e.g. ${keys.slice(0, 3).join(', ')}`,
      )
    }
    if (chunk.text.includes(ZOD_MARKER)) failures.push(`${chunk.name}: zod (${ZOD_MARKER})`)
    if (chunk.text.includes(SUPABASE_AUTH_MARKER)) {
      failures.push(`${chunk.name}: Supabase auth (${SUPABASE_AUTH_MARKER})`)
    }
  }
  for (const chunk of [...input.shell, ...input.others]) {
    for (const hook of TEST_HOOK_MARKERS) {
      if (chunk.text.includes(hook)) failures.push(`${chunk.name}: test hook ${hook}`)
    }
    for (const name of SERVER_ONLY_MARKERS) {
      if (chunk.text.includes(name)) failures.push(`${chunk.name}: server-only name ${name}`)
    }
  }
  if (!input.shell.some((chunk) => input.bootKeys.some((key) => hasKeyLiteral(chunk.text, key)))) {
    failures.push('no boot copy key found in the shell: the scan cannot see the copy')
  }
  if (input.markers.length === 0) failures.push('no cc-feature markers found in src')
  for (const marker of input.markers) {
    if (!input.others.some((chunk) => hasMarker(chunk.text, marker))) {
      failures.push(`${marker} is in no lazy chunk: the scan cannot see that feature`)
    }
  }
  if (input.shellGzBytes > input.maxShellGzBytes) {
    failures.push(
      `shell is ${input.shellGzBytes} bytes gz, over the ${input.maxShellGzBytes} allowed (shellJsGzKB - shellHeadroomGzKB)`,
    )
  }
  return failures
}

const LimitsSchema = z.object({
  shellJsGzKB: PerfConfigSchema.shape.shellJsGzKB,
  shellHeadroomGzKB: PerfConfigSchema.shape.shellHeadroomGzKB,
})

/** Bytes the shell may use: (shellJsGzKB - shellHeadroomGzKB) * 1000. */
export function maxShellGzBytes(perf: unknown): number {
  const result = LimitsSchema.safeParse(perf)
  if (!result.success) {
    throw new Error('data/config/perf.json: shellJsGzKB and shellHeadroomGzKB must be numbers')
  }
  const bytes = Math.round((result.data.shellJsGzKB - result.data.shellHeadroomGzKB) * 1000)
  if (bytes <= 0) throw new Error('data/config/perf.json: shellHeadroomGzKB leaves no shell budget')
  return bytes
}

async function files(dir: string, extension: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

/** Feature marker ids rendered by src (test files excluded). */
export async function findMarkers(srcDir: string): Promise<string[]> {
  const found = new Set<string>()
  for (const file of await files(srcDir, '.tsx')) {
    if (/\.test\.tsx$/.test(file)) continue
    for (const match of (await readFile(file, 'utf8')).matchAll(MARKER)) found.add(match[0])
  }
  return [...found].sort()
}

/** The namespaces the copy core registers itself (its `import './ns/<ns>'` lines). */
export function bootNamespaces(copyCore: string): string[] {
  return [...copyCore.matchAll(/^import '\.\/ns\/(\w+)'$/gm)].map((match) => match[1] ?? '')
}

const NamespaceFileSchema = z.object({ strings: z.record(z.string(), z.string()) })

/** Base keys under data/copy, split into boot and feature namespaces. */
export async function readCopyKeys(copyDir: string, boot: readonly string[]) {
  const bootKeys: string[] = []
  const featureKeys: string[] = []
  const entries = await readdir(copyDir, { withFileTypes: true })
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const raw: unknown = JSON.parse(await readFile(join(copyDir, entry.name, 'base.json'), 'utf8'))
    const keys = Object.keys(NamespaceFileSchema.parse(raw).strings)
    ;(boot.includes(entry.name) ? bootKeys : featureKeys).push(...keys)
  }
  return { bootKeys, featureKeys }
}

async function main(): Promise<void> {
  const root = process.cwd()
  const distDir = join(root, '.next')
  const perf: unknown = JSON.parse(await readFile(join(root, 'data/config/perf.json'), 'utf8'))
  const maxBytes = maxShellGzBytes(perf)

  let html: string
  try {
    html = await readFile(join(distDir, 'server/app/index.html'), 'utf8')
  } catch {
    throw new Error('No prerendered / found in .next/server/app/index.html. Run `npm run build`.')
  }
  const { external, inline } = extractScripts(html)
  if (external.length === 0) throw new Error('No external scripts found for /: unexpected build')

  const staticDir = join(distDir, 'static')
  const shellPaths = new Set(external.map((src) => staticFilePath(src, distDir)))
  const shell: Chunk[] = [{ name: 'inline', text: inline.join('\n') }]
  let shellGzBytes = gzipBytes(inline.join('\n'))
  for (const path of shellPaths) {
    const content = await readFile(path)
    shellGzBytes += gzipBytes(content)
    shell.push({ name: relative(staticDir, path), text: content.toString('utf8') })
  }
  const others: Chunk[] = []
  for (const path of await files(staticDir, '.js')) {
    if (shellPaths.has(path)) continue
    others.push({ name: relative(staticDir, path), text: await readFile(path, 'utf8') })
  }

  const boot = bootNamespaces(await readFile(join(root, 'src/lib/copy/index.ts'), 'utf8'))
  const { bootKeys, featureKeys } = await readCopyKeys(join(root, 'data/copy'), boot)
  const markers = await findMarkers(join(root, 'src'))

  const failures = shellGuardFailures({
    shell,
    others,
    markers,
    bootKeys,
    featureKeys,
    shellGzBytes,
    maxShellGzBytes: maxBytes,
  })
  const kb = (bytes: number) => (bytes / 1000).toFixed(1)
  const lines =
    failures.length === 0
      ? [
          `PASS Shell boot path (/): ${kb(shellGzBytes)} KB gz (limit ${kb(maxBytes)} KB with headroom); boot copy ${boot.join(', ')}; ${markers.length} features lazy; no test hooks`,
        ]
      : ['FAIL Shell boot path (/):', ...failures.map((failure) => `  ${failure}`)]
  process.stdout.write(`${lines.join('\n')}\n`)
  if (failures.length > 0) process.exitCode = 1
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`shell-guard: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
