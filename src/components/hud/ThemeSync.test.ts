import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readStoredTheme } from '@/components/legal/StoredTheme'
import { UI_THEME_KEY } from '@/lib/uiThemeKey'
import { applyUiTheme, glassMode } from './ThemeSync'

/** The bits of <html> applyUiTheme touches. */
function fakeRoot() {
  const attributes = new Map<string, string>()
  const meta = { content: '', setAttribute: (_: string, value: string) => (meta.content = value) }
  const root = {
    dataset: {} as Record<string, string>,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    ownerDocument: { querySelector: () => meta },
  }
  return { root, attributes, meta, element: root as unknown as HTMLElement }
}

const OPTIONS = { fadeMs: 400, instant: false, themeColor: '#0e1116' }

describe('applyUiTheme (S04g)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('switches the root to the theme with a cross-fade that ends after the configured time', () => {
    const { root, attributes, meta, element } = fakeRoot()
    root.dataset.theme = 'day'
    applyUiTheme(element, 'night', OPTIONS)
    expect(root.dataset.theme).toBe('night')
    expect(attributes.has('data-theme-fading')).toBe(true)
    expect(meta.content).toBe('#0e1116')
    vi.advanceTimersByTime(399)
    expect(attributes.has('data-theme-fading')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(attributes.has('data-theme-fading')).toBe(false)
  })

  it('is instant under reduced motion, and does nothing when the theme is already shown', () => {
    const { root, attributes, meta, element } = fakeRoot()
    root.dataset.theme = 'day'
    applyUiTheme(element, 'night', { ...OPTIONS, instant: true })
    expect(root.dataset.theme).toBe('night')
    expect(attributes.has('data-theme-fading')).toBe(false)
    meta.content = 'untouched'
    applyUiTheme(element, 'night', OPTIONS)
    expect(meta.content).toBe('untouched')
    expect(attributes.has('data-theme-fading')).toBe(false)
  })

  it('stores the theme even when the root already shows it (UI-2: night left from last session)', () => {
    const stored = new Map<string, string>([[UI_THEME_KEY, 'night']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    })
    try {
      const { root, meta, element } = fakeRoot()
      // The server HTML says day, and the clock says day: nothing to switch, but the store
      // must stop saying night so /credits and /terms open in day.
      root.dataset.theme = 'day'
      meta.content = 'untouched'
      applyUiTheme(element, 'day', OPTIONS)
      expect(stored.get(UI_THEME_KEY)).toBe('day')
      expect(readStoredTheme(localStorage)).toBe('day')
      expect(meta.content).toBe('untouched')
      applyUiTheme(element, 'night', OPTIONS)
      expect(stored.get(UI_THEME_KEY)).toBe('night')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('restarts the fade when the theme flips back before it ends', () => {
    const { root, attributes, element } = fakeRoot()
    root.dataset.theme = 'day'
    applyUiTheme(element, 'night', OPTIONS)
    vi.advanceTimersByTime(300)
    applyUiTheme(element, 'day', { ...OPTIONS, themeColor: '#eef1f4' })
    vi.advanceTimersByTime(300)
    expect(attributes.has('data-theme-fading')).toBe(true)
    vi.advanceTimersByTime(100)
    expect(attributes.has('data-theme-fading')).toBe(false)
    expect(root.dataset.theme).toBe('day')
  })
})

describe('glass (PERF-2)', () => {
  it('frosts only on mid and high, without data saver or reduced transparency', () => {
    const base = { dataSaver: false, reducedTransparency: false }
    expect(glassMode({ ...base, tier: 'high' })).toBe('blur')
    expect(glassMode({ ...base, tier: 'mid' })).toBe('blur')
    expect(glassMode({ ...base, tier: 'low' })).toBe('solid')
    expect(glassMode({ ...base, tier: null })).toBe('solid')
    expect(glassMode({ ...base, tier: 'high', dataSaver: true })).toBe('solid')
    expect(glassMode({ ...base, tier: 'high', reducedTransparency: true })).toBe('solid')
  })
})

describe('stored theme for pages without the clock (Q3)', () => {
  it('shows the last theme the game showed, else day', () => {
    const storage = (value: string | null) => ({
      getItem: (key: string) => (key === UI_THEME_KEY ? value : null),
    })
    expect(readStoredTheme(storage('night'))).toBe('night')
    expect(readStoredTheme(storage('day'))).toBe('day')
    expect(readStoredTheme(storage(null))).toBe('day')
    expect(readStoredTheme(storage('purple'))).toBe('day')
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error('SecurityError')
        },
      }),
    ).toBe('day')
  })
})
