/**
 * S04g: every text and control colour pair of both interface palettes meets WCAG 2.2 AA:
 * 4.5:1 for text (1.4.3) and 3:1 for focus rings, control borders and meters (1.4.11). Glass is
 * checked where it is translucent too, composited over pure black and pure white (the extremes
 * the map can show behind it).
 */
import { describe, expect, it } from 'vitest'
import { theme } from '@/lib/data/config'
import { UI_TOKENS, type UiToken } from '@/lib/data/schemas/config'
import { UI_THEMES, type UiTheme } from '@/lib/dayNight/types'

type Rgb = readonly [number, number, number]

function rgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** `top` at `alpha` over `bottom`, in sRGB (what the browser's color-mix in srgb does). */
function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return top.map((channel, i) => channel * alpha + (bottom[i] ?? 0) * (1 - alpha)) as unknown as Rgb
}

/** WCAG 2.x relative luminance. */
function luminance(color: Rgb): number {
  const [r, g, b] = color.map((channel) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as unknown as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const BLACK: Rgb = [0, 0, 0]
const WHITE: Rgb = [255, 255, 255]

function palette(ui: UiTheme): Record<UiToken, Rgb> {
  return Object.fromEntries(
    UI_TOKENS.map((token) => {
      const hex = theme.colors[theme.ui[ui][token]]
      if (hex === undefined) throw new Error(`no colour for ${ui} ${token}`)
      return [token, rgb(hex)]
    }),
  ) as Record<UiToken, Rgb>
}

/** Every background text and controls sit on, by name, for a theme. */
function backgrounds(ui: UiTheme): Record<string, Rgb> {
  const p = palette(ui)
  const alpha = theme.ui.glassAlpha[ui]
  return {
    canvas: p.canvas,
    surface: p.surface,
    raised: p.raised,
    'glass over black': over(p.glass, alpha, BLACK),
    'glass over white': over(p.glass, alpha, WHITE),
    // Inset rows (`bg-canvas/60`) on a glass panel.
    'row on surface': over(p.canvas, 0.6, p.surface),
  }
}

/** Text colours and the minimum ratio each needs on every background. */
const TEXT: readonly UiToken[] = ['fg', 'muted', 'taxi-ink', 'danger', 'success']
/** Non-text colours (focus ring, strong borders) that must stand out from every background. */
const NON_TEXT: readonly UiToken[] = ['focus', 'line-strong']

describe.each(UI_THEMES)('the %s interface palette (WCAG 2.2 AA)', (ui) => {
  const p = palette(ui)

  it.each(TEXT)('%s text reads at 4.5:1 on every background', (token) => {
    for (const [name, background] of Object.entries(backgrounds(ui))) {
      expect(contrast(p[token], background), `${token} on ${name}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('body text also reads on pressed controls', () => {
    expect(contrast(p.fg, p.pressed)).toBeGreaterThanOrEqual(4.5)
  })

  it('text on the taxi accent (buttons, badges) reads at 4.5:1, also on a pressed accent', () => {
    expect(contrast(p['on-taxi'], p.taxi)).toBeGreaterThanOrEqual(4.5)
    // The goals button's open state: the accent at 25% over a raised control.
    const tinted = over(p.taxi, 0.25, p.raised)
    expect(contrast(p['taxi-ink'], tinted)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.fg, tinted)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(NON_TEXT)('%s stands out at 3:1 from every background', (token) => {
    for (const [name, background] of Object.entries(backgrounds(ui))) {
      expect(contrast(p[token], background), `${token} on ${name}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('the focus ring also shows on the taxi accent and on raised controls', () => {
    // Day: a dark ring on yellow; night: the yellow ring sits on dark controls only.
    if (ui === 'day') expect(contrast(p.focus, p.taxi)).toBeGreaterThanOrEqual(3)
    expect(contrast(p.focus, p.raised)).toBeGreaterThanOrEqual(3)
  })

  it('meters stand out from their track at 3:1', () => {
    expect(contrast(p.meter, p.track)).toBeGreaterThanOrEqual(3)
  })

  it('the selected-state accent border (taxi-ink) stands out at 3:1 from raised controls', () => {
    expect(contrast(p['taxi-ink'], p.raised)).toBeGreaterThanOrEqual(3)
  })
})

describe('contrast maths', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast(BLACK, WHITE)).toBeCloseTo(21, 5)
    expect(contrast(WHITE, WHITE)).toBeCloseTo(1, 5)
    expect(contrast(rgb('#777777'), WHITE)).toBeCloseTo(4.48, 2)
  })
})
