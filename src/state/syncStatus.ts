/**
 * Where cloud save sync stands (S18c), for the HUD's CloudSaveStatus chip and its sheet.
 * Session-only, never persisted, and tiny: the chip reads it without loading the sync code
 * (src/state/cloudSync.ts), which registers its controls here once it runs.
 *
 *  - `local`: saved on this device only (no session yet, or no cloud in this build).
 *  - `syncing`: an upload is under way, or a change waits for one.
 *  - `synced`: the account holds this device's latest save.
 *  - `offline`: changes wait for the network.
 *  - `paused`: the server refused the save (or the session); retried later.
 *  - `conflict`: the account holds different progress; the player picks one.
 *  - `update`: the account's save is from a newer build.
 *  - `behind`: the player kept this device's game, but it is from before the account's last
 *    prestige, so it cannot replace the account's game; the account's game is offered.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

export const SYNC_STATUSES = [
  'local',
  'syncing',
  'synced',
  'offline',
  'paused',
  'conflict',
  'update',
  'behind',
] as const
export type SyncStatus = (typeof SYNC_STATUSES)[number]

/** What the sheet can ask the sync to do (registered by src/state/cloudSync.ts). */
export interface SyncControls {
  /** Uploads now (paused or waiting). */
  retryNow(): void
  /** Settles a conflict: keep this device's progress, or take the account's. */
  resolveConflict(choice: 'keep-local' | 'use-cloud'): void
  /** Replaces this device's game with the account's (after a refused save; only on a tap). */
  useCloud(): void
}

export interface SyncStatusState {
  readonly status: SyncStatus
  /** True after the server refused this device's save (422), until a save is accepted or taken. */
  readonly rejected: boolean
  readonly controls: SyncControls | null
}

export const INITIAL_SYNC_STATUS: SyncStatusState = {
  status: 'local',
  rejected: false,
  controls: null,
}

export type SyncStatusStore = ReturnType<typeof createSyncStatusStore>

export function createSyncStatusStore() {
  return createStore<SyncStatusState>()(() => INITIAL_SYNC_STATUS)
}

export const syncStatusStore: SyncStatusStore = createSyncStatusStore()

/** React binding. */
export function useSyncStatus(): SyncStatusState {
  return useStore(syncStatusStore)
}
