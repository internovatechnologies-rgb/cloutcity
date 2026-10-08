'use client'

/**
 * On pages without the game clock (legal pages, credits, the offline page): after mount, shows
 * the interface theme the game last showed (S04g, Q3), or keeps the server's day palette when
 * there is none, and gives the browser chrome the same theme colour (UI-14). Instant: nothing on
 * these pages moves.
 */
import { useEffect } from 'react'
import { UI_THEME_KEY } from '@/lib/uiThemeKey'

export function readStoredTheme(storage: Pick<Storage, 'getItem'>): 'day' | 'night' {
  try {
    return storage.getItem(UI_THEME_KEY) === 'night' ? 'night' : 'day'
  } catch {
    // Storage can be off (private mode): day, like the server rendered.
    return 'day'
  }
}

export function StoredTheme({
  themeColor,
}: {
  /** The browser theme colour of each interface theme (src/lib/theme.ts `themeColorHex`). */
  readonly themeColor: Readonly<Record<'day' | 'night', string>>
}) {
  const { day, night } = themeColor
  useEffect(() => {
    const theme = readStoredTheme(localStorage)
    document.documentElement.dataset.theme = theme
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'night' ? night : day)
  }, [day, night])
  return null
}
