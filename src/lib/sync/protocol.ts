/**
 * The cloud save protocol (S18c) between the device (src/state/cloudSync.ts) and the server
 * (POST /api/save, src/server/saves/handleUpload.ts). Types and constants only, so both sides
 * share it without pulling either's code into the other.
 */
import type { Repair } from '@/engine/repairs'

export const SAVE_ROUTE = '/api/save'

/** The upload request body. */
export interface UploadBody {
  /** The save format version the device wrote (src/engine/save.ts SAVE_VERSION). */
  readonly saveVersion: number
  /** The cloud revision the upload is based on: 0 when the account has no save yet. */
  readonly baseRevision: number
  /** A random id per device (local storage), so a lost reply can be told from another device. */
  readonly deviceId: string
  /** When the device made the save (epoch ms), or null. */
  readonly clientSavedAt: number | null
  readonly save: unknown
  /**
   * "Keep this device" after a conflict: the last revision this device synced, the save both
   * devices last shared. The upload (based on the account's current revision) is then checked
   * against that save instead of the other device's, and stored on top. Absent otherwise.
   */
  readonly overrideFromRevision?: number | null
}

/** Which save the account holds now, without the save itself. */
export interface CloudHead {
  readonly revision: number
  readonly saveVersion: number
  readonly acceptedAt: string | null
  readonly deviceId: string | null
}

/** The account's save as the server holds it (the device reads it with its own session). */
export interface CloudCopy extends CloudHead {
  readonly data: unknown
}

export type UploadReply =
  /** Stored as `revision`, after `repairs` (apply them on the device too). */
  | {
      readonly ok: true
      readonly revision: number
      readonly acceptedAt: string
      readonly repairs: readonly Repair[]
      /** Grant keys the server now holds (src/engine/grants.ts `markGrantsSynced`). */
      readonly syncedGrantKeys: readonly string[]
    }
  /**
   * The cloud moved on since `baseRevision` (another device, or a reply that never arrived).
   * Only the head is sent back: the device reads the save itself if it needs it.
   */
  | { readonly ok: false; readonly code: 'conflict'; readonly head: CloudHead | null }
  /** The save failed plausibility; it was kept aside and not stored. */
  | { readonly ok: false; readonly code: 'rejected' }
  | { readonly ok: false; readonly code: 'rate-limited'; readonly retryAfterMs: number }
  /**
   * "Keep this device" with a game from before the account's last prestige: it cannot replace
   * the account's game (its badges would be lost). Not retried: the device offers the account's.
   */
  | { readonly ok: false; readonly code: 'branch-behind' }
  /** The save format differs from the server's: one side needs a newer build. */
  | { readonly ok: false; readonly code: 'version'; readonly serverVersion: number }
  | {
      readonly ok: false
      readonly code:
        'unauthenticated' | 'attestation-required' | 'invalid' | 'too-large' | 'unavailable'
    }

export type UploadFailureCode = Extract<UploadReply, { ok: false }>['code']
