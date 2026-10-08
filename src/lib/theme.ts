import type { CSSProperties } from 'react'
import { scene, theme } from '@/lib/data/config'
import { items } from '@/lib/data/content'
import { UI_TOKENS, type UiToken } from '@/lib/data/schemas/config'
import {
  resolveDayNight,
  resolveSkyColors,
  type DayNightModel,
  UI_THEMES,
  type SkyColors,
  type ThemeDayNight,
  type UiTheme,
} from '@/lib/dayNight'
import type { UiThemeClock } from '@/lib/dayNight/uiSchedule'
import type { ScenePalette } from '@/scene/types'

/** CSS custom property that carries one swatch colour (HomePanel decor variants). */
export function paletteVar(token: string): `--palette-${string}` {
  return `--palette-${token}`
}

/** CSS custom property of one semantic interface colour in one theme (globals.css reads it). */
export function uiVar(ui: UiTheme, token: UiToken): `--ui-${UiTheme}-${string}` {
  return `--ui-${ui}-${token}`
}

/** Hex of one DOM palette token; theme.json's schema guarantees every reference exists. */
function colorHex(token: string): string {
  const hex = theme.colors[token]
  if (hex === undefined) throw new Error(`theme.json: unknown colour token "${token}"`)
  return hex
}

/** Every token a decor variant names (data/items/items.json): the swatch colours. */
export function swatchTokens(): string[] {
  const tokens = items.flatMap((item) => item.decor?.variants.map((variant) => variant.token) ?? [])
  return [...new Set(tokens)].sort()
}

/**
 * The root element's style (S04g): both interface themes' colours as `--ui-day-<token>` and
 * `--ui-night-<token>` (globals.css picks one set with the root's `data-theme`), the cross-fade
 * and glass settings, and the swatch colours. CSS variables only: the shell gains no JS.
 */
export function uiStyle(): CSSProperties {
  const style: Record<string, string> = {}
  for (const ui of UI_THEMES) {
    for (const token of UI_TOKENS) style[uiVar(ui, token)] = colorHex(theme.ui[ui][token])
    style[`--ui-${ui}-glass-alpha`] = `${Math.round(theme.ui.glassAlpha[ui] * 100)}%`
  }
  style['--ui-fade-ms'] = `${theme.ui.crossFadeMs}ms`
  style['--ui-glass-blur'] = `${theme.ui.glassBlurPx}px`
  for (const token of swatchTokens()) style[paletteVar(token)] = colorHex(token)
  return style as CSSProperties
}

/** Hex of the browser/PWA theme colour of an interface theme (day until the clock is known). */
export function themeColorHex(ui: UiTheme = 'day'): string {
  return colorHex(theme.themeColor[ui])
}

/**
 * What the HUD island needs to follow the clock with the interface (S04g): the minute each
 * keyframe starts and its theme (the same keyframes as the scene, S04f), the cross-fade and the
 * browser theme colours. A few numbers: no theme or scene file reaches the client.
 */
export function uiThemeClock(): UiThemeClock {
  return {
    schedule: scene.dayNight.keyframes.map((keyframe) => ({
      atMinute: keyframe.atMinute,
      ui: keyframe.ui,
    })),
    crossFadeMs: theme.ui.crossFadeMs,
    themeColor: { day: themeColorHex('day'), night: themeColorHex('night') },
  }
}

/** The world palette: 3D-only colours plus the models' real-material colours (DEC-26). */
const worldColors: Readonly<Record<string, string>> = { ...theme.world, ...theme.models }

/** Hex of one world token; theme.json's schema guarantees every scene reference exists. */
function tokenHex(token: string): string {
  const hex = worldColors[token]
  if (hex === undefined) throw new Error(`theme.json: unknown world token "${token}"`)
  return hex
}

const themeDayNight: ThemeDayNight = { colors: worldColors, sky: theme.sky }

/**
 * Each day/night keyframe's colours (S04f), resolved to hex on the server: the 3D chunk joins
 * them with the keyframes of the scene config it already gets, so neither the theme nor the
 * keyframes travel twice.
 */
export function skyColors(): SkyColors {
  return resolveSkyColors(themeDayNight)
}

/** The day/night model the city lights by (scene.json keyframes, theme.json sky colours). */
export function dayNightModel(): DayNightModel {
  return resolveDayNight(scene.dayNight, themeDayNight)
}

/**
 * The 3D city's colours resolved from palette tokens to hex on the server, so the scene chunk
 * needs neither the config loader nor any colour literal.
 */
export function scenePalette(): ScenePalette {
  const { scene } = theme
  return {
    haze: tokenHex(scene.haze),
    water: tokenHex(scene.water),
    land: {
      manhattan: tokenHex(scene.land.manhattan),
      brooklyn: tokenHex(scene.land.brooklyn),
      queens: tokenHex(scene.land.queens),
      bronx: tokenHex(scene.land.bronx),
      'staten-island': tokenHex(scene.land['staten-island']),
    },
    park: tokenHex(scene.park),
    cemetery: tokenHex(scene.cemetery),
    subwayLines: scene.subwayLines.map(tokenHex),
    subwayCasing: tokenHex(scene.subwayCasing),
    station: tokenHex(scene.station),
    player: tokenHex(scene.player),
    labelInk: tokenHex(scene.labelInk),
    pins: {
      venue: tokenHex(scene.pins.venue),
      landmark: tokenHex(scene.pins.landmark),
      teaser: tokenHex(scene.pins.teaser),
      muted: tokenHex(scene.pins.muted),
      selected: tokenHex(scene.pins.selected),
    },
    chip: { fill: tokenHex(scene.chip.fill), ink: tokenHex(scene.chip.ink) },
    travel: {
      taxi: tokenHex(scene.travel.taxi),
      train: tokenHex(scene.travel.train),
      trail: tokenHex(scene.travel.trail),
    },
    toonRamp: [...scene.toonRamp],
    buildings: {
      walls: scene.buildings.walls.map(tokenHex),
      roof: tokenHex(scene.buildings.roof),
      window: tokenHex(scene.buildings.window),
      blocks: scene.buildings.blocks.map(tokenHex),
      dimmedBlock: tokenHex(scene.buildings.dimmedBlock),
    },
    landmarks: Object.fromEntries(
      Object.entries(scene.landmarks).map(([role, token]) => [role, tokenHex(token)]),
    ) as ScenePalette['landmarks'],
  }
}
