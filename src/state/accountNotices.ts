/**
 * Moderator notices the player has not acknowledged yet (S18b), shown once at session start.
 * Session-only UI state, never persisted, and deliberately tiny like iconMoment.ts: the shell's
 * modal mount reads it, so the notice with its copy and the safety API loads only when there is
 * one (DEC-11). The guest session fills it after connecting (src/state/session.ts).
 */
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'
import type { AccountNotice, SafetyApi } from '@/lib/supabase/safetyApi'

interface AccountNoticesState {
  readonly notices: readonly AccountNotice[]
  /** The API the notices came from, to acknowledge and appeal them. */
  readonly api: SafetyApi | null
}

const EMPTY: AccountNoticesState = { notices: [], api: null }

export const accountNoticesStore = createStore<AccountNoticesState>()(() => EMPTY)

export function setAccountNotices(notices: readonly AccountNotice[], api: SafetyApi): void {
  accountNoticesStore.setState({ notices, api })
}

/** Drops the notice with `id` (acknowledged, or put away for this session). */
export function removeAccountNotice(id: string): void {
  const { notices } = accountNoticesStore.getState()
  accountNoticesStore.setState({ notices: notices.filter((notice) => notice.id !== id) })
}

export function clearAccountNotices(): void {
  accountNoticesStore.setState(EMPTY)
}

const hasNotices = () => accountNoticesStore.getState().notices.length > 0
const serverHasNotices = () => false

/** True while a notice waits to be shown; false during the server render and hydration. */
export function useHasAccountNotices(): boolean {
  return useSyncExternalStore(accountNoticesStore.subscribe, hasNotices, serverHasNotices)
}
