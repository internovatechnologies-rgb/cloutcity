/**
 * The share hook (S15): shares a moment's text and the site's address with the system share
 * sheet, falling back to the clipboard, then to showing the text for the player to copy. The
 * text comes from copy (`share.*`, ending with the share footer); the address is the site's
 * origin only, with no player ids, handles or anything else that identifies the player.
 */
import { log } from '@/lib/log'

/** The parts of `navigator` the share hook uses (a test passes its own). */
export interface ShareNavigator {
  readonly share?: (data: ShareData) => Promise<void>
  readonly clipboard?: { readonly writeText: (text: string) => Promise<void> }
}

export type ShareOutcome =
  /** The system share sheet took it. */
  | { readonly kind: 'shared' }
  /** The player closed the share sheet: nothing else happens. */
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'copied' }
  /** Neither worked: show `text` so the player can copy it. */
  | { readonly kind: 'shown'; readonly text: string }

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

export async function shareMoment(
  text: string,
  url: string,
  nav: ShareNavigator = navigator,
): Promise<ShareOutcome> {
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ text, url })
      return { kind: 'shared' }
    } catch (error) {
      if (errorName(error) === 'AbortError') return { kind: 'cancelled' }
      // Not allowed here (no user activation, an unsupported payload): try the clipboard.
      log.info('The share sheet was unavailable; trying the clipboard', { error: errorName(error) })
    }
  }
  const full = `${text} ${url}`
  if (typeof nav.clipboard?.writeText === 'function') {
    try {
      await nav.clipboard.writeText(full)
      return { kind: 'copied' }
    } catch (error) {
      log.info('The clipboard was unavailable; showing the text to copy', {
        error: errorName(error),
      })
    }
  }
  return { kind: 'shown', text: full }
}
