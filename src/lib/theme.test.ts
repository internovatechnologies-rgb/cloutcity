import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { balance, scene, theme } from '@/lib/data/config'
import { lightingAt } from '@/lib/dayNight/lightingAt'
import { uiThemeAt } from '@/lib/dayNight/uiThemeAt'
import { UI_TOKENS } from '@/lib/data/schemas/config'
import { uiThemeFor } from '@/lib/dayNight/uiSchedule'
import {
  dayNightModel,
  paletteVar,
  swatchTokens,
  themeColorHex,
  uiStyle,
  uiThemeClock,
  uiVar,
} from './theme'

const SRC = join(import.meta.dirname, '..')
const css = readFileSync(join(SRC, 'app/globals.css'), 'utf8')

describe('theme tokens', () => {
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`)
    if (start < 0) throw new Error(`globals.css has no ${selector} block`)
    return css.slice(start, css.indexOf('}', start))
  }

  it('globals.css maps exactly the semantic interface colours to Tailwind colours (S04g)', () => {
    const mapped = Array.from(
      block('@theme inline').matchAll(/--color-([a-z-]+):\s*var\(--ui-([a-z-]+)\)/g),
    )
    expect(mapped.every(([, color, ui]) => color === ui)).toBe(true)
    expect(mapped.map(([, token]) => token)).toEqual([...UI_TOKENS])
    // The stock palette is gone: no other colour is a Tailwind colour.
    expect(css).toMatch(/--color-\*:\s*initial;/)
  })

  it('switches every semantic colour between the day and night sets with data-theme', () => {
    for (const [selector, ui] of [
      [':root', 'day'],
      [":root[data-theme='night']", 'night'],
    ] as const) {
      const mapped = Array.from(
        block(selector).matchAll(
          new RegExp(`--ui-([a-z-]+):\\s*var\\(--ui-${ui}-([a-z-]+)\\)`, 'g'),
        ),
      ).filter(([, token]) => token !== 'glass-alpha')
      expect(mapped.every(([, token, source]) => token === source)).toBe(true)
      expect(mapped.map(([, token]) => token)).toEqual([...UI_TOKENS])
    }
  })

  it('writes both themes, the cross-fade and the swatches on the root element, as hex', () => {
    const style = uiStyle() as Record<string, string>
    for (const ui of ['day', 'night'] as const) {
      for (const token of UI_TOKENS) {
        expect(style[uiVar(ui, token)]).toBe(theme.colors[theme.ui[ui][token]])
        expect(style[uiVar(ui, token)]).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
    expect(style['--ui-fade-ms']).toBe(`${theme.ui.crossFadeMs}ms`)
    // Only colours: no raw palette or 3D colour reaches the page.
    expect(Object.keys(style).filter((name) => name.startsWith('--palette-'))).toEqual(
      swatchTokens().map(paletteVar),
    )
    for (const token of swatchTokens()) expect(style[paletteVar(token)]).toBe(theme.colors[token])
    expect(themeColorHex()).toBe(theme.colors[theme.themeColor.day])
    expect(themeColorHex('night')).toBe(theme.colors[theme.themeColor.night])
  })

  it('every decor swatch is a DOM colour, and no swatch is a semantic token name', () => {
    expect(swatchTokens().length).toBeGreaterThan(0)
    for (const token of swatchTokens()) expect(Object.hasOwn(theme.colors, token)).toBe(true)
  })

  it('no stylesheet or component under src/ hardcodes a colour', () => {
    const files = readdirSync(SRC, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(css|tsx?)$/.test(entry.name))
      .filter((entry) => !entry.name.endsWith('.test.ts'))
      .map((entry) => join(entry.parentPath, entry.name))
    const offenders = files.filter((file) =>
      /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})

describe('day/night model (S04f)', () => {
  const model = dayNightModel()

  it('runs on a game day of 1440 minutes, the length the keyframes are written for', () => {
    expect(balance.time.gameDayHours * 60).toBe(1440)
  })

  it('resolves every keyframe of scene.json with its sky colours from theme.json', () => {
    expect(model.keyframes.map((keyframe) => keyframe.id)).toEqual(
      scene.dayNight.keyframes.map((keyframe) => keyframe.id),
    )
    for (const keyframe of model.keyframes) {
      for (const hex of Object.values(keyframe.colors)) expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('is day at the unknown minute a new game starts with, with no night glow', () => {
    const start = lightingAt(scene.dayNight.unknownMinute, model)
    expect(start.ui).toBe('day')
    expect(start.nightGlow).toBe(0)
  })

  it('switches the interface on the same keyframes as the scene, for every minute', () => {
    for (let minute = 0; minute < 1440; minute++) {
      expect(uiThemeAt(minute, model)).toBe(lightingAt(minute, model).ui)
    }
  })

  it('glows fully at night and never by day', () => {
    expect(lightingAt(21 * 60, model).nightGlow).toBe(1)
    expect(lightingAt(3 * 60, model).nightGlow).toBe(1)
    expect(lightingAt(12 * 60, model).nightGlow).toBe(0)
  })
})

describe('interface theme clock (S04g)', () => {
  const model = dayNightModel()
  const clock = uiThemeClock()

  it('switches the interface exactly when the scene does, for every minute of the day', () => {
    for (let minute = 0; minute < 1440; minute++) {
      expect(uiThemeFor(minute, clock.schedule)).toBe(uiThemeAt(minute, model))
    }
  })

  it('goes dark at dusk and light again at dawn, and carries only a few numbers', () => {
    expect(uiThemeFor(12 * 60, clock.schedule)).toBe('day')
    expect(uiThemeFor(22 * 60, clock.schedule)).toBe('night')
    expect(uiThemeFor(2 * 60, clock.schedule)).toBe('night')
    expect(clock.schedule).toHaveLength(scene.dayNight.keyframes.length)
    expect(clock.themeColor).toEqual({ day: themeColorHex('day'), night: themeColorHex('night') })
    expect(JSON.stringify(clock).length).toBeLessThan(400)
  })
})
