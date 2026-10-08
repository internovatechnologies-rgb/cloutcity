/**
 * When the update notice (S04e, data-cc-notice "update") shows: a new build is waiting (or already
 * took over from another tab), the player has not put off that build, and nothing more important
 * holds the screen. A modal (the welcome card, the Icon moment) and the first-run tour (S06, GR-9)
 * each come first; the notice shows once they are gone. "Later" puts off one build, by its
 * worker's id: a newer build arriving later in the session is offered again (F6).
 */
import type { UpdateId } from './serviceWorker'

export interface UpdateNoticeState {
  /** The newest build on offer, or null when none is. */
  readonly update: UpdateId | null
  /** The build the player put off, or null. */
  readonly dismissed: UpdateId | null
  readonly modalOpen: boolean
  readonly touring: boolean
}

export function updateNoticeShown(state: UpdateNoticeState): boolean {
  return (
    state.update !== null && state.update !== state.dismissed && !state.modalOpen && !state.touring
  )
}
