'use client'

/**
 * The interface theme follows the personal game clock (S04g): light frosted cards by day, dark
 * glass by night, switching on the same keyframes as the 3D scene (S04f). Called from the HUD's
 * live island, which knows the clock; the server HTML says `data-theme="day"` until then, so no
 * inline script runs before paint and the shell carries only CSS variables.
 *
 * A switch cross-fades colours for `crossFadeMs` (globals.css, `data-theme-fading`), or is
 * instant under reduced motion. The same island turns on frosted glass (`data-glass="blur"`)
 * only where the device can afford a backdrop blur over the map (PERF-2): mid and high tiers,
 * no data saver, no reduced transparency.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { QualityTier } from '@/lib/data/schemas/config'
import type { UiTheme } from '@/lib/dayNight/types'
import { uiThemeFor, type UiThemeClock } from '@/lib/dayNight/uiSchedule'
import { log } from '@/lib/log'
import { UI_THEME_KEY } from '@/lib/uiThemeKey'
import { useReducedMotion } from '@/lib/useReducedMotion'
import { useMinuteOfDay } from '@/state/dayClock'
import { selectActiveTier, useQualityState } from '@/state/quality'

export const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)'

export type GlassMode = 'blur' | 'solid'

export function glassMode(input: {
  readonly tier: QualityTier | null
  readonly dataSaver: boolean
  readonly reducedTransparency: boolean
}): GlassMode {
  const affordable = input.tier === 'mid' || input.tier === 'high'
  return affordable && !input.dataSaver && !input.reducedTransparency ? 'blur' : 'solid'
}

/** Pending end of a cross-fade, so a quick second switch restarts it. */
let fadeTimer: ReturnType<typeof setTimeout> | undefined

/** Remembers the theme for pages without the clock (StoredTheme): /credits, /terms, /offline. */
function storeUiTheme(theme: UiTheme): void {
  try {
    localStorage.setItem(UI_THEME_KEY, theme)
  } catch (error) {
    // Storage can be off (private mode, quota): the other pages then show day.
    log.debug('ui theme not stored', { error: error instanceof Error ? error.name : 'unknown' })
  }
}

/**
 * Puts `theme` on the root element (and the browser's theme colour), cross-fading over
 * `fadeMs` unless `instant`, and stores it. When the root already shows it (a day load after the
 * server's day HTML) only the store is written: a night left stored from the last session would
 * otherwise keep the other pages dark (UI-2).
 */
export function applyUiTheme(
  root: HTMLElement,
  theme: UiTheme,
  options: { readonly fadeMs: number; readonly instant: boolean; readonly themeColor: string },
): void {
  storeUiTheme(theme)
  if (root.dataset.theme === theme) return
  if (fadeTimer !== undefined) clearTimeout(fadeTimer)
  fadeTimer = undefined
  const fade = !options.instant && options.fadeMs > 0
  if (fade) root.setAttribute('data-theme-fading', '')
  else root.removeAttribute('data-theme-fading')
  root.dataset.theme = theme
  root.ownerDocument
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', options.themeColor)
  if (fade) {
    fadeTimer = setTimeout(() => {
      root.removeAttribute('data-theme-fading')
      fadeTimer = undefined
    }, options.fadeMs)
  }
}

function subscribeTransparency(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(REDUCED_TRANSPARENCY_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const transparencyNow = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches
const transparencyOnServer = () => false

export function useThemeSync(clock: UiThemeClock): void {
  const minute = useMinuteOfDay()
  const reducedMotion = useReducedMotion()
  const quality = useQualityState()
  const reducedTransparency = useSyncExternalStore(
    subscribeTransparency,
    transparencyNow,
    transparencyOnServer,
  )
  // Day until the HUD has read the save.
  const theme: UiTheme | null = minute === null ? null : uiThemeFor(minute, clock.schedule)

  useEffect(() => {
    if (theme === null) return
    applyUiTheme(document.documentElement, theme, {
      fadeMs: clock.crossFadeMs,
      instant: reducedMotion,
      themeColor: clock.themeColor[theme],
    })
  }, [theme, reducedMotion, clock])

  const glass = glassMode({
    tier: selectActiveTier(quality),
    dataSaver: quality.dataSaver,
    reducedTransparency,
  })
  useEffect(() => {
    document.documentElement.dataset.glass = glass
  }, [glass])
}
