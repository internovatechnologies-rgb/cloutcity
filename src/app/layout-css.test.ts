/**
 * The HUD's breakpoints live in data/config/layout.json, but CSS media queries cannot read
 * config: globals.css repeats them in the `hud-wide` / `hud-short` variants and the rule that
 * switches the HUD row to its compact height (S05). This keeps the copies equal.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { layout } from '@/lib/data/config'

const css = readFileSync(join(import.meta.dirname, 'globals.css'), 'utf8')
const { hudWideMinWidthPx, hudCompactMaxHeightPx, hudTinyMaxWidthPx } = layout.overlay

const wide = `(min-width: ${hudWideMinWidthPx}px)`
const short = `(min-width: ${hudWideMinWidthPx}px) and (max-height: ${hudCompactMaxHeightPx}px)`

/** Every media query in the file, in order. */
const mediaQueries = [...css.matchAll(/@media ([^{)]+\)(?:\s*and\s*\([^)]*\))*)/g)].map((match) =>
  match[1]?.trim(),
)

describe('globals.css HUD breakpoints (S05)', () => {
  it('defines hud-wide at hudWideMinWidthPx', () => {
    expect(css).toContain(`@custom-variant hud-wide (@media ${wide});`)
  })

  it('defines hud-short at hudWideMinWidthPx and hudCompactMaxHeightPx, after hud-wide', () => {
    const shortVariant = `@custom-variant hud-short (@media ${short});`
    expect(css).toContain(shortVariant)
    expect(css.indexOf(shortVariant)).toBeGreaterThan(css.indexOf('@custom-variant hud-wide'))
  })

  it('defines hud-tiny at hudTinyMaxWidthPx, below hud-wide (UI-1)', () => {
    expect(css).toContain(`@custom-variant hud-tiny (@media (max-width: ${hudTinyMaxWidthPx}px));`)
    expect(hudTinyMaxWidthPx).toBeLessThan(hudWideMinWidthPx)
  })

  it('switches the HUD row to the compact height under the same query as hud-short', () => {
    const rule = css.slice(css.indexOf(`@media ${short} {`))
    expect(css).toContain(`@media ${short} {`)
    expect(rule).toMatch(
      /^@media [^{]+\{\s*\.cc-overlay \{\s*--overlay-hud-h: var\(--overlay-hud-compact-h\) !important;/,
    )
  })

  it('names no other HUD threshold (self-check: the scan sees the media queries)', () => {
    expect(mediaQueries).toContain(short)
    for (const query of mediaQueries) {
      for (const px of query?.matchAll(/(min-width|max-height|max-width): (\d+)px/g) ?? []) {
        const allowed =
          px[1] === 'min-width'
            ? hudWideMinWidthPx
            : px[1] === 'max-width'
              ? hudTinyMaxWidthPx
              : hudCompactMaxHeightPx
        expect(Number(px[2]), query).toBe(allowed)
      }
    }
  })
})
