/**
 * An in-memory SafetyApi for the e2e test hook (safetyTestHook.ts): no live player surface exists
 * before S29, so specs drive PlayerActions and the notice modal against this fake. It answers
 * like the S18b RPCs (an undo id per block, duplicates by reason) and records every call by name
 * only. Test builds only; never imported by product code.
 */
import type { ApiErrorCode, ApiResult } from '@/lib/supabase/rpc'
import type { AccountNotice, SafetyApi } from '@/lib/supabase/safetyApi'

export interface FakeSafetyApiOptions {
  /** Calls (by method name) that fail with the given code. */
  readonly failures?: Readonly<Partial<Record<keyof SafetyApi, ApiErrorCode>>>
  /** What block_player reports it ended. */
  readonly endsFriendship?: boolean
  readonly notices?: readonly AccountNotice[]
  /** The server's undo window for a block (default 10 s); undo ids past it restore nothing. */
  readonly undoSeconds?: number
}

export interface FakeSafetyApi extends SafetyApi {
  /** Every call so far, as `method:target` (never a note or appeal body). */
  readonly calls: string[]
}

export function createFakeSafetyApi(options: FakeSafetyApiOptions = {}): FakeSafetyApi {
  const calls: string[] = []
  const blocked = new Map<string, string>()
  const undoExpiry = new Map<string, number>()
  const muted = new Set<string>()
  const reports = new Set<string>()
  let undo = 0
  const answer = <T>(
    method: keyof SafetyApi,
    target: string,
    data: () => T,
  ): Promise<ApiResult<T>> => {
    calls.push(`${method}:${target}`)
    const code = options.failures?.[method]
    return Promise.resolve(code === undefined ? { ok: true, data: data() } : { ok: false, code })
  }
  return {
    calls,
    block: (target) =>
      answer('block', target, () => {
        // Already blocked: block_player changes nothing and offers no undo.
        if (blocked.has(target)) {
          return { undoId: null, undoExpiresAt: null, friendshipEnded: false, roommateEnded: false }
        }
        undo += 1
        const undoId = `undo-${undo}`
        const expiresAt = Date.now() + (options.undoSeconds ?? 10) * 1000
        blocked.set(target, undoId)
        undoExpiry.set(undoId, expiresAt)
        return {
          undoId,
          undoExpiresAt: new Date(expiresAt).toISOString(),
          friendshipEnded: options.endsFriendship ?? false,
          roommateEnded: false,
        }
      }),
    unblock: (target, undoId) =>
      answer('unblock', target, () => {
        const restored =
          undoId !== undefined &&
          blocked.get(target) === undoId &&
          (undoExpiry.get(undoId) ?? 0) > Date.now()
        const unblocked = blocked.delete(target)
        return {
          unblocked,
          friendshipRestored: restored && (options.endsFriendship ?? false),
          roommateRestored: false,
        }
      }),
    mute: (target) => answer('mute', target, () => (muted.add(target), null)),
    unmute: (target) => answer('unmute', target, () => (muted.delete(target), null)),
    listBlocks: () =>
      answer('listBlocks', '', () =>
        [...blocked.keys()].map((id) => ({ playerId: id, handle: id, at: '2026-10-07T00:00:00Z' })),
      ),
    listMutes: () =>
      answer('listMutes', '', () =>
        [...muted].map((id) => ({ playerId: id, handle: id, at: '2026-10-07T00:00:00Z' })),
      ),
    report: (input) =>
      answer('report', input.target, () => {
        const key = `${input.target}:${input.kind}:${input.reason}`
        const duplicate = reports.has(key)
        reports.add(key)
        return { report_id: `report-${reports.size}`, duplicate }
      }),
    openNotices: () => answer('openNotices', '', () => options.notices ?? []),
    acknowledgeNotice: (id) => answer('acknowledgeNotice', id, () => null),
    appeal: (noticeId) => answer('appeal', noticeId, () => ({ appealId: `appeal-${noticeId}` })),
  }
}
