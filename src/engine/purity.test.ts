/**
 * The engine is pure and deterministic (CLAUDE.md "Architecture rules"): it never reads the
 * real clock or a random source, and imports no React, three, Supabase, store or UI code.
 * ESLint enforces it (eslint.config.mjs, src/engine block); this test proves the rule fires and
 * that the engine's sources are clean.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const ENGINE = join(ROOT, 'src/engine')

const eslint = new ESLint({ cwd: ROOT })
async function ruleIds(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath) })
  return (result?.messages ?? []).map((message) => message.ruleId)
}

describe('engine purity', () => {
  it.each([
    ['Date.now()', 'export const a = Date.now()\n', 'no-restricted-globals'],
    ['new Date()', 'export const a = new Date()\n', 'no-restricted-globals'],
    ['Date()', 'export const a = Date()\n', 'no-restricted-globals'],
    ['Math.random()', 'export const a = Math.random()\n', 'no-restricted-syntax'],
    ['performance.now()', 'export const a = performance.now()\n', 'no-restricted-globals'],
    ['crypto', 'export const a = crypto.randomUUID()\n', 'no-restricted-globals'],
    ['setTimeout', 'export const a = setTimeout\n', 'no-restricted-globals'],
    ['globalThis access', 'export const a = globalThis.Date\n', 'no-restricted-globals'],
    [
      'any Date reference',
      'export const a = (ms: number) => new Date(ms)\n',
      'no-restricted-globals',
    ],
    ['Date.UTC', 'export const a = Date.UTC(2026, 0, 1)\n', 'no-restricted-globals'],
    ['an aliased Math', 'const M = Math\nexport const a = M\n', 'no-restricted-syntax'],
    ['require()', "export const a = require('zustand')\n", 'no-restricted-syntax'],
    [
      'a relative scene import',
      "import { City } from '../scene/City'\nexport const a = City\n",
      'no-restricted-imports',
    ],
    ['Intl', "export const a = new Intl.DateTimeFormat('en-US')\n", 'no-restricted-syntax'],
    [
      'a React import',
      "import { useState } from 'react'\nexport const a = useState\n",
      'no-restricted-imports',
    ],
    [
      'a three import',
      "import { Vector3 } from 'three'\nexport const a = Vector3\n",
      'no-restricted-imports',
    ],
    [
      'a Supabase import',
      "import { createClient } from '@supabase/supabase-js'\nexport const a = createClient\n",
      'no-restricted-imports',
    ],
    [
      'a store import',
      "import { gameStore } from '@/state/store'\nexport const a = gameStore\n",
      'no-restricted-imports',
    ],
  ])(
    'lint rejects %s in src/engine',
    async (_label, code, rule) => {
      expect(await ruleIds(code, 'src/engine/probe.ts')).toContain(rule)
    },
    30_000,
  )

  // Indirect routes to the real clock, randomness or framework code. Each must be reported by
  // some rule (which one is the implementation's choice).
  it.each([
    ['an aliased Date', 'const D = Date\nexport const a = D.now()\n'],
    ['destructured Date.now', 'const { now } = Date\nexport const a = now()\n'],
    ["computed Date['now']", "export const a = Date['now']()\n"],
    ["computed Math['random']", "export const a = Math['random']()\n"],
    ['destructured Math.random', 'const { random } = Math\nexport const a = random()\n'],
    ["Reflect.get(Math, 'random')", "export const a = Reflect.get(Math, 'random')\n"],
    ['new globalThis.Date()', 'export const a = new globalThis.Date()\n'],
    ['self.performance', 'export const a = self.performance.now()\n'],
    ["dynamic import('react')", "export const a = () => import('react')\n"],
    ["dynamic import('three')", "export const a = () => import('three')\n"],
    ["require('three')", "export const a = require('three')\n"],
    [
      'a relative store import',
      "import { gameStore } from '../state/store'\nexport const a = gameStore\n",
    ],
  ])(
    'lint rejects %s in src/engine',
    async (_label, code) => {
      expect(await ruleIds(code, 'src/engine/probe.ts')).not.toEqual([])
    },
    30_000,
  )

  it('allows plain Math helpers and the formatter wall-clock helper', async () => {
    const code = [
      "import { wallClockParts } from '@/lib/format'",
      "import { calendar } from './clock'",
      "export const a = (ms: number) => Math.floor(wallClockParts(ms, 'UTC').hour / 2)",
      'export const b = calendar',
      '',
    ].join('\n')
    expect(await ruleIds(code, 'src/engine/probe.ts')).toEqual([])
  }, 30_000)

  it('the engine sources hold no clock, randomness, globals or framework imports', () => {
    const forbidden = [
      /\bDate\b/,
      /\bReflect\b/,
      /\bself\b/,
      /\bglobalThis\b/,
      /\bperformance\b/,
      /\bMath\s*(\.\s*random\b|\[)/,
      /\bimport\s*\(/,
      /\brequire\s*\(/,
      /from\s+['"](react|react-dom|three|zustand|next)(\/[^'"]*)?['"]/,
      /from\s+['"]@(react-three|supabase)\/[^'"]+['"]/,
      /from\s+['"][^'"]*\/(state|components|scene|realtime|server|app)(\/[^'"]*)?['"]/,
    ]
    // Comments may name what is banned; only code counts.
    const code = (file: string) =>
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
    const sources = readdirSync(ENGINE, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && /(?<!\.test)\.ts$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
    expect(sources.map((file) => file.slice(ENGINE.length + 1))).toContain('clock.ts')
    const offenders = sources.flatMap((file) =>
      forbidden
        .filter((pattern) => pattern.test(code(file)))
        .map((pattern) => `${file.slice(ENGINE.length + 1)}: ${pattern}`),
    )
    expect(offenders).toEqual([])
  })
})
