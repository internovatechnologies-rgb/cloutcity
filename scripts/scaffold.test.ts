/**
 * S01 scaffold contract: pins, scripts, lint rules, Playwright projects, manifest, Supabase and
 * .gitignore. Each check reads the real file or tool, so it fails if the clause it guards breaks.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import playwrightConfig, { WEBGL_LAUNCH_ARGS } from '../playwright.config'
import manifest from '../src/app/manifest'

const ROOT = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

interface PackageJson {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}
const pkg = JSON.parse(read('package.json')) as PackageJson
const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

// Exact versions from CLAUDE.md "Stack".
const PINNED: Readonly<Record<string, string>> = {
  next: '16.3.8',
  react: '19.3.0',
  'react-dom': '19.3.0',
  typescript: '6.0.3',
  tailwindcss: '4.3.3',
  three: '0.182.0',
  '@react-three/fiber': '9.8.1',
  '@react-three/drei': '10.7.9',
  '@types/three': '0.182.0',
  '@playwright/test': '1.63.0',
}

describe('dependency pins', () => {
  it.each(Object.entries(PINNED))('%s is pinned exactly to %s', (name, version) => {
    expect(allDeps[name]).toBe(version)
  })

  it('the 3D packages are runtime dependencies with no range operator', () => {
    for (const name of ['three', '@react-three/fiber', '@react-three/drei']) {
      expect(pkg.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('Vitest is on major 5 and the Supabase CLI is a devDependency', () => {
    expect(pkg.devDependencies.vitest).toMatch(/^5\.\d+\.\d+$/)
    expect(pkg.devDependencies.supabase).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.dependencies.supabase).toBeUndefined()
  })

  it('installed versions match the pins (lockfile not drifted)', () => {
    for (const name of ['next', 'three', '@react-three/fiber', '@react-three/drei', 'typescript']) {
      const installed = JSON.parse(read(`node_modules/${name}/package.json`)) as { version: string }
      expect(installed.version, name).toBe(PINNED[name])
    }
  })
})

describe('npm scripts', () => {
  it.each([
    ['dev', /^next dev\b/],
    ['build', /^next build\b/],
    ['start', /^next start\b/],
    ['typecheck', /\btsc --noEmit\b/],
    ['lint', /^eslint\b/],
    ['format:check', /^prettier --check\b/],
    ['test', /^vitest run\b/],
    ['e2e', /^playwright test\b/],
    ['budget', /scripts\/budget\.ts\b/],
  ])('%s runs %s', (name, command) => {
    expect(pkg.scripts[name]).toMatch(command)
  })

  it('TypeScript runs in strict mode', () => {
    const tsconfig = JSON.parse(read('tsconfig.json')) as { compilerOptions: { strict?: boolean } }
    expect(tsconfig.compilerOptions.strict).toBe(true)
  })
})

describe('lint rules', () => {
  const eslint = new ESLint({ cwd: ROOT })
  const ruleIds = async (code: string, filePath: string) => {
    const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath) })
    return (result?.messages ?? []).map((m) => `${m.ruleId}:${m.severity}`)
  }

  it('bans console.* in app, scripts and tests as an error', async () => {
    for (const file of ['src/lib/probe.ts', 'scripts/probe.ts', 'tests/e2e/probe.spec.ts']) {
      expect(await ruleIds('console.log("x")\n', file), file).toContain('no-console:2')
    }
  }, 30_000)

  it('runs jsx-a11y rules as errors on components', async () => {
    const code = 'export function A() {\n  return <img src="/x.png" />\n}\n'
    expect(await ruleIds(code, 'src/components/Probe.tsx')).toContain('jsx-a11y/alt-text:2')
  }, 30_000)
})

describe('Playwright config', () => {
  const projects = playwrightConfig.projects ?? []
  const project = (name: string) => projects.find((p) => p.name === name)

  it('keeps specs in tests/e2e', () => {
    expect(playwrightConfig.testDir).toBe('tests/e2e')
  })

  it('has a 390x844 touch project and a 1280 desktop project', () => {
    expect(project('mobile-390')?.use).toMatchObject({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })
    expect(project('desktop-1280')?.use?.viewport?.width).toBe(1280)
  })

  it('documents every WebGL launch flag in the README', () => {
    expect(playwrightConfig.use?.launchOptions?.args).toEqual(WEBGL_LAUNCH_ARGS)
    const readme = read('README.md')
    for (const flag of WEBGL_LAUNCH_ARGS) expect(readme, flag).toContain(flag)
  })
})

describe('PWA manifest', () => {
  it('names the app and has 192 and 512 PNG icons that exist', () => {
    const m = manifest()
    expect(m.name).toBe('Clout City: NYC')
    expect(m.short_name).toBe('Clout City')
    expect(m.display).toBe('standalone')
    for (const icon of m.icons ?? []) {
      expect(existsSync(join(ROOT, 'public', icon.src)), icon.src).toBe(true)
    }
    const sizes = (m.icons ?? []).map((icon) => icon.sizes)
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']))
  })
})

describe('Supabase', () => {
  it('has an initialised config.toml with a project id', () => {
    expect(read('supabase/config.toml')).toMatch(/^project_id = "[a-z0-9-]+"$/m)
  })
})

describe('.gitignore', () => {
  // `--no-index` judges the patterns alone, whether or not a path is tracked or exists.
  const ignored = (path: string): boolean => {
    try {
      execFileSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: ROOT })
      return true
    } catch {
      return false
    }
  }

  it.each([
    '.env',
    '.env.local',
    '.env.production.local',
    '.env.development',
    '.next/server/app/index.html',
    'out/index.html',
    'next-env.d.ts',
    'tsconfig.tsbuildinfo',
    'test-results/run/trace.zip',
    'playwright-report/index.html',
    'blob-report/report.zip',
    'coverage/lcov.info',
    '.cache/geo/pluto.zip',
    'node_modules/next/package.json',
  ])('ignores %s', (path) => {
    expect(ignored(path)).toBe(true)
  })

  it.each([
    '.env.example',
    'src/app/page.tsx',
    'data/config/perf.json',
    'tests/e2e/shell.spec.ts',
    'tests/e2e/__screenshots__/overlay-layers.spec.ts/overlay-shell-mobile-390-darwin.png',
    'supabase/config.toml',
    'src/lib/cache/index.ts',
  ])('keeps %s', (path) => {
    expect(ignored(path)).toBe(false)
  })
})
