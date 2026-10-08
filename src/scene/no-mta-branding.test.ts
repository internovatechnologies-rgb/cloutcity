/**
 * S04a: subway lines are drawn in our own palette with plain letters, never MTA trade dress
 * (the trunk-line colours and the white-letter circle "bullets"). Scans the theme, the scene
 * config and the geo data the scene reads, so a later palette or data change cannot bring an
 * MTA colour back in.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')

/** MTA trunk-line colours (published MTA brand standards), lower case, no '#'. */
const MTA_TRUNK_HEXES = [
  'ee352e', // 1 2 3
  '00933c', // 4 5 6
  'b933ad', // 7
  '0039a6', // A C E
  'ff6319', // B D F M
  '6cbe45', // G
  '996633', // J Z
  'a7a9ac', // L
  'fccc0a', // N Q R W
  '808183', // S
  '00add0', // SIR
]

const SCANNED = [
  'data/config/theme.json',
  'data/config/scene.json',
  'data/geo/subway.derived.json',
  'src/app/globals.css',
]

interface Theme {
  world: Record<string, string>
  models: Record<string, string>
  scene: { subwayLines: string[]; labelInk: string; station: string }
}
const theme = JSON.parse(read('data/config/theme.json')) as Theme
/** Scene colours name world or models tokens (theme.json, DEC-26). */
const worldHex = (token: string): string | undefined => theme.world[token] ?? theme.models[token]

/** Euclidean distance of two #rrggbb colours in 0–255 RGB. */
function rgbDistance(a: string, b: string): number {
  const channels = (hex: string) =>
    [0, 2, 4].map((at) => parseInt(hex.replace('#', '').slice(at, at + 2), 16))
  const [x, y] = [channels(a), channels(b)]
  return Math.hypot(...x.map((value, i) => value - (y[i] ?? 0)))
}

/** A colour this close to an MTA trunk colour would read as that line. */
const MIN_MTA_DISTANCE = 40
const scene = JSON.parse(read('data/config/scene.json')) as {
  labels: { cornerRadius: number }
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** Travel copy (S08): plain line names only, no operator name, no claim of real-time data. */
const TRAVEL_COPY = ['data/copy/travel/base.json', 'data/copy/tour/base.json']

describe('no MTA branding in travel copy (S08)', () => {
  for (const file of TRAVEL_COPY) {
    it(`${file} names no transit operator and claims no real-time or official data`, () => {
      const text = read(file)
      expect(text).not.toMatch(/\bMTA\b|Metropolitan Transportation|\bNYCT\b/i)
      expect(text).not.toMatch(/real[- ]time|official|live (?:train|subway|transit)|accurate/i)
    })
  }

  it('the travel palette is not an MTA colour', () => {
    const travel = (theme.scene as unknown as { travel: Record<string, string> }).travel
    for (const token of Object.values(travel)) {
      expect(MTA_TRUNK_HEXES).not.toContain(worldHex(token)?.slice(1).toLowerCase())
    }
  })
})

describe('no MTA branding in the scene (S04a)', () => {
  for (const file of SCANNED) {
    it(`${file} contains no MTA trunk-line colour`, () => {
      const text = read(file).toLowerCase()
      const found = MTA_TRUNK_HEXES.filter((hex) => new RegExp(`#?${hex}\\b`).test(text))
      expect(found).toEqual([])
    })
  }

  it('every subway line colour is one of our palette tokens, not an MTA colour', () => {
    expect(theme.scene.subwayLines.length).toBeGreaterThan(0)
    for (const token of theme.scene.subwayLines) {
      const hex = worldHex(token)
      expect(hex, `token ${token}`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(MTA_TRUNK_HEXES).not.toContain(hex?.slice(1).toLowerCase())
    }
  })

  it('no subway line colour is near an MTA trunk colour either (S04f real-world palette)', () => {
    for (const token of theme.scene.subwayLines) {
      for (const mta of MTA_TRUNK_HEXES) {
        expect(
          rgbDistance(worldHex(token) ?? '#000000', mta),
          `${token} vs #${mta}`,
        ).toBeGreaterThan(MIN_MTA_DISTANCE)
      }
    }
  })

  it('line chips are rounded squares with dark letters, not white-letter circles', () => {
    // A corner radius of half the chip would make a circle (the MTA bullet shape).
    expect(scene.labels.cornerRadius).toBeLessThan(0.5)
    const ink = worldHex(theme.scene.labelInk)
    expect(ink, `labelInk token ${theme.scene.labelInk}`).toBeDefined()
    // Dark ink: far from the MTA's white lettering.
    expect(luminance(ink ?? '#ffffff')).toBeLessThan(0.2)
  })
})
