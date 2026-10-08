/**
 * `node scripts/shell-guard.ts` end to end against throwaway projects, so a guard that cannot
 * fail is caught (budget.cli.test.ts pattern).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gzipBytes } from './budget.ts'

const SCRIPT = join(import.meta.dirname, 'shell-guard.ts')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SHELL_JS = 'self.copy=JSON.parse(\'{"strings":{"tabs.map":"Map"}}\');'
const INLINE = 'self.__next_f=[]'
const SHELL_GZ = gzipBytes(SHELL_JS) + gzipBytes(INLINE)

interface Fake {
  readonly shellJs?: string
  readonly lazyJs?: string
  readonly shellJsGzKB?: number
  readonly withBuild?: boolean
}

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

function fakeProject({
  shellJs = SHELL_JS,
  lazyJs = 'x({"data-cc-feature":"cc-feature:event-sheet","k":"events.ui.continue"})',
  shellJsGzKB = 180,
  withBuild = true,
}: Fake = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shell-guard-'))
  dirs.push(root)
  write(root, 'data/config/perf.json', JSON.stringify({ shellJsGzKB, shellHeadroomGzKB: 20 }))
  write(root, 'data/copy/tabs/base.json', JSON.stringify({ strings: { 'tabs.map': 'Map' } }))
  write(
    root,
    'data/copy/events/base.json',
    JSON.stringify({ strings: { 'events.ui.continue': 'Continue' } }),
  )
  write(root, 'src/lib/copy/index.ts', "import './ns/tabs'\n")
  write(root, 'src/components/EventSheet.tsx', '<div data-cc-feature="cc-feature:event-sheet" />\n')
  if (withBuild) {
    write(root, '.next/static/chunks/shell.js', shellJs)
    write(root, '.next/static/chunks/lazy.js', lazyJs)
    write(
      root,
      '.next/server/app/index.html',
      `<html><body><script src="/_next/static/chunks/shell.js" async=""></script><script>${INLINE}</script></body></html>`,
    )
  }
  return root
}

const run = (cwd: string) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' })

describe('shell-guard CLI', () => {
  it('exits 0 and prints PASS for a boot-only shell', () => {
    const result = run(fakeProject())
    expect(result.stdout).toMatch(/^PASS Shell boot path/m)
    expect(result.status).toBe(0)
  })

  it('passes at exactly shellJsGzKB minus the headroom and fails one byte over', () => {
    expect(run(fakeProject({ shellJsGzKB: 20 + SHELL_GZ / 1000 })).status).toBe(0)
    const over = run(fakeProject({ shellJsGzKB: 20 + (SHELL_GZ - 1) / 1000 }))
    expect(over.stdout).toMatch(/over the \d+ allowed/)
    expect(over.status).toBe(1)
  })

  it('fails when a feature module or its copy is in the shell', () => {
    const result = run(
      fakeProject({ shellJs: `${SHELL_JS}x("cc-feature:event-sheet","events.ui.continue")` }),
    )
    expect(result.stdout).toMatch(/feature module cc-feature:event-sheet/)
    expect(result.stdout).toMatch(/feature copy key/)
    expect(result.status).toBe(1)
  })

  it('fails when a test hook is in any chunk', () => {
    const result = run(
      fakeProject({ lazyJs: 'x("cc-feature:event-sheet");window.__cloutcityTest={}' }),
    )
    expect(result.stdout).toMatch(/test hook __cloutcityTest/)
    expect(result.status).toBe(1)
  })

  it('exits non-zero when there is no build', () => {
    const result = run(fakeProject({ withBuild: false }))
    expect(result.stderr).toMatch(/npm run build/)
    expect(result.status).toBe(1)
  })
})
