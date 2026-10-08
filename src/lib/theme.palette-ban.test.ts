/**
 * S04g (DEC-26): the indigo/hot-pink palette is retired and the interface uses only the semantic
 * colours (`bg-surface`, `text-fg`, `outline-focus`, ...), so a later change or merge cannot
 * bring a raw palette colour back into the DOM UI. Scans every DOM source: components, app
 * routes and the scene's DOM files.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..')

/** Raw colour families (numbered tokens): ours, retired or not, and Tailwind's stock ones. */
const FAMILIES =
  'night|pink|ink|indigo|violet|lilac|sea|sky|mint|orange|teal|sand|charcoal|cream|taxi|stone|' +
  'slate|snow|mist|smoke|coal|fog|amber|red|green|gray|grey|zinc|neutral|blue|yellow|purple|' +
  'rose|emerald|lime|cyan|fuchsia'

const UTILITIES =
  'bg|text|border|ring|outline|stroke|fill|from|via|to|accent|divide|shadow|caret|decoration|placeholder'

/** A colour utility naming a raw palette colour, e.g. `bg-night-900/95`, `hover:text-pink-400`. */
const RAW_CLASS = new RegExp(
  `(?:^|[\\s"'\`:])(?:${UTILITIES})-(?:(?:${FAMILIES})-\\d{2,3}|white|black)(?:/\\d+)?(?=[\\s"'\`\\]]|$)`,
  'm',
)
/** An arbitrary value or style naming a raw palette variable, e.g. `var(--color-taxi-400)`. */
const RAW_VAR = new RegExp(`--color-(?:${FAMILIES})-\\d`)

function domSources(): string[] {
  const dirs = ['components', 'app', 'scene']
  return dirs.flatMap((dir) =>
    readdirSync(join(SRC, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(tsx|ts|css)$/.test(entry.name))
      .filter((entry) => !/\.test\.tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
      // The 3D scene's three code has no classes; its DOM files are .tsx.
      .filter((file) => dir !== 'scene' || file.endsWith('.tsx')),
  )
}

describe('retired palette (S04g)', () => {
  it('finds the DOM sources it guards', () => {
    expect(domSources().length).toBeGreaterThan(40)
  })

  it('no DOM source uses a raw palette colour class or variable', () => {
    const offenders = domSources().flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      const hits = [text.match(RAW_CLASS)?.[0], text.match(RAW_VAR)?.[0]].filter(
        (hit): hit is string => hit !== undefined,
      )
      return hits.map((hit) => `${relative(SRC, file)}: ${hit.trim()}`)
    })
    expect(offenders).toEqual([])
  })

  it('catches the retired classes it is meant to', () => {
    for (const sample of [
      'className="bg-night-900/95 p-3"',
      'className="hover:text-pink-400"',
      'className="outline-taxi-400"',
      'className="bg-indigo-500"',
      "'bg-white'",
    ]) {
      expect(RAW_CLASS.test(sample), sample).toBe(true)
    }
    for (const sample of [
      'className="bg-surface text-fg"',
      'className="outline-offset-2"',
      'className="text-taxi-ink"',
      'className="bg-canvas/60 border-line-strong"',
    ]) {
      expect(RAW_CLASS.test(sample), sample).toBe(false)
    }
    expect(RAW_VAR.test('var(--color-pink-400)')).toBe(true)
    expect(RAW_VAR.test('var(--color-focus)')).toBe(false)
  })
})
