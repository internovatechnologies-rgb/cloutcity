/**
 * Block, mute, report and account notices (S18b), for PlayerActions, the Me panel's blocked and
 * muted lists and the notice shown at session start. Each answer is validated with zod/mini.
 *
 * The server decides everything: who can be blocked, what a note may hold, whether an appeal is
 * allowed. These calls only carry the player's choice and report the server's answer. A report
 * note is sent, never logged (CLAUDE.md "Logging").
 *
 * {@link lazySafetyApi} is the API every player surface uses: it loads supabase-js on the first
 * call, after the guest is online. The e2e suite drives the same components with an in-memory
 * fake through the {@link SafetyApi} port.
 */
import * as z from 'zod/mini'
import { SubmitReportResultSchema, type SubmitReportResult } from '@/lib/forms/report'
import {
  NOTICE_KINDS,
  REPORT_REASONS,
  type ReportKind,
  type ReportReason,
} from '@/lib/safety/reports'
import { supabaseEnv, type SupabaseEnv } from './env'
import {
  VoidSchema,
  callRpc,
  failure,
  oneRow,
  readResponse,
  type ApiResult,
  type RpcResponse,
  type RpcTransport,
} from './rpc'

export interface BlockResult {
  /** Null when the player was already blocked: nothing changed, so there is nothing to undo. */
  readonly undoId: string | null
  /** When the server's undo window closes (its clock); null with `undoId`. */
  readonly undoExpiresAt: string | null
  readonly friendshipEnded: boolean
  readonly roommateEnded: boolean
}

export interface UnblockResult {
  readonly unblocked: boolean
  readonly friendshipRestored: boolean
  readonly roommateRestored: boolean
}

/** One row of the player's block or mute list. `handle` is what others would see, or null. */
export interface ListedPlayer {
  readonly playerId: string
  readonly handle: string | null
  readonly at: string
}

export interface ReportInput {
  readonly target: string
  readonly kind: ReportKind
  readonly reason: ReportReason
  /** As typed; the server trims it and treats a blank note as none. */
  readonly note: string
  /** One per report attempt, so a retry never files it twice. */
  readonly idempotencyKey: string
}

export interface AccountNotice {
  readonly id: string
  readonly kind: (typeof NOTICE_KINDS)[number]
  readonly reason: ReportReason | null
  readonly endsAt: string | null
  readonly createdAt: string
  /** Set when the notice is about a sanction (only those can be appealed). */
  readonly sanctionId: string | null
}

/** The safety calls a player surface makes. */
export interface SafetyApi {
  block(target: string): Promise<ApiResult<BlockResult>>
  /** With the block's undo id, inside its window, what the block ended comes back. */
  unblock(target: string, undoId?: string): Promise<ApiResult<UnblockResult>>
  mute(target: string): Promise<ApiResult<null>>
  unmute(target: string): Promise<ApiResult<null>>
  listBlocks(): Promise<ApiResult<readonly ListedPlayer[]>>
  listMutes(): Promise<ApiResult<readonly ListedPlayer[]>>
  report(input: ReportInput): Promise<ApiResult<SubmitReportResult>>
  /** Notices the player has not acknowledged yet, oldest first. */
  openNotices(): Promise<ApiResult<readonly AccountNotice[]>>
  acknowledgeNotice(id: string): Promise<ApiResult<null>>
  appeal(noticeId: string, body: string): Promise<ApiResult<{ readonly appealId: string }>>
}

/** The database calls the safety API makes: functions, plus one owner-only table read. */
export interface SafetyTransport extends RpcTransport {
  /** `account_notices` rows the player has not acknowledged, oldest first (RLS: own rows). */
  openNotices(): PromiseLike<RpcResponse>
}

const BlockSchema = oneRow(
  z.object({
    undo_id: z.nullable(z.string()),
    undo_expires_at: z.nullable(z.string()),
    friendship_ended: z.boolean(),
    roommate_ended: z.boolean(),
  }),
)
const UnblockSchema = oneRow(
  z.object({
    unblocked: z.boolean(),
    friendship_restored: z.boolean(),
    roommate_restored: z.boolean(),
  }),
)
const BlockListSchema = z.array(
  z.object({ player_id: z.string(), handle: z.nullable(z.string()), blocked_at: z.string() }),
)
const MuteListSchema = z.array(
  z.object({ player_id: z.string(), handle: z.nullable(z.string()), muted_at: z.string() }),
)
const ReportSchema = oneRow(SubmitReportResultSchema)
const AppealSchema = oneRow(z.object({ appeal_id: z.string() }))
const NoticesSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.enum(NOTICE_KINDS),
    reason: z.nullable(z.enum(REPORT_REASONS)),
    ends_at: z.nullable(z.string()),
    created_at: z.string(),
    sanction_id: z.nullable(z.string()),
  }),
)

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data })

/** Maps a successful result's data; a failure passes through. */
function map<A, B>(result: ApiResult<A>, to: (data: A) => B): ApiResult<B> {
  return result.ok ? ok(to(result.data)) : result
}

export function createSafetyApi(transport: SafetyTransport): SafetyApi {
  const done = (result: ApiResult<unknown>): ApiResult<null> => map(result, () => null)
  return {
    block: async (target) =>
      map(await callRpc(transport, 'block_player', { p_target: target }, BlockSchema), (row) => ({
        undoId: row.undo_id,
        undoExpiresAt: row.undo_expires_at,
        friendshipEnded: row.friendship_ended,
        roommateEnded: row.roommate_ended,
      })),
    unblock: async (target, undoId) =>
      map(
        await callRpc(
          transport,
          'unblock_player',
          undoId === undefined ? { p_target: target } : { p_target: target, p_undo: undoId },
          UnblockSchema,
        ),
        (row) => ({
          unblocked: row.unblocked,
          friendshipRestored: row.friendship_restored,
          roommateRestored: row.roommate_restored,
        }),
      ),
    mute: async (target) =>
      done(await callRpc(transport, 'mute_player', { p_target: target }, VoidSchema)),
    unmute: async (target) =>
      done(await callRpc(transport, 'unmute_player', { p_target: target }, VoidSchema)),
    listBlocks: async () =>
      map(await callRpc(transport, 'list_my_blocks', {}, BlockListSchema), (rows) =>
        rows.map((row) => ({ playerId: row.player_id, handle: row.handle, at: row.blocked_at })),
      ),
    listMutes: async () =>
      map(await callRpc(transport, 'list_my_mutes', {}, MuteListSchema), (rows) =>
        rows.map((row) => ({ playerId: row.player_id, handle: row.handle, at: row.muted_at })),
      ),
    report: (input) =>
      callRpc(
        transport,
        'submit_report',
        {
          p_target: input.target,
          p_kind: input.kind,
          p_reason: input.reason,
          p_note: input.note,
          p_idempotency_key: input.idempotencyKey,
        },
        ReportSchema,
      ),
    openNotices: async () => {
      let response: RpcResponse
      try {
        response = await transport.openNotices()
      } catch {
        return failure('unknown')
      }
      return map(readResponse(response, NoticesSchema), (rows) =>
        rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          reason: row.reason,
          endsAt: row.ends_at,
          createdAt: row.created_at,
          sanctionId: row.sanction_id,
        })),
      )
    },
    acknowledgeNotice: async (id) =>
      done(await callRpc(transport, 'acknowledge_notice', { p_notice_id: id }, VoidSchema)),
    appeal: async (noticeId, body) =>
      map(
        await callRpc(
          transport,
          'submit_appeal',
          { p_notice_id: noticeId, p_body: body },
          AppealSchema,
        ),
        (row) => ({ appealId: row.appeal_id }),
      ),
  }
}

/** A SafetyApi whose every call answers `code`. */
export function unavailableSafetyApi(
  code: 'not_authenticated' | 'unknown' = 'not_authenticated',
): SafetyApi {
  const fail = () => Promise.resolve(failure(code))
  return {
    block: fail,
    unblock: fail,
    mute: fail,
    unmute: fail,
    listBlocks: fail,
    listMutes: fail,
    report: fail,
    openNotices: fail,
    acknowledgeNotice: fail,
    appeal: fail,
  }
}

/**
 * The safety API on the guest's own session (loads supabase-js). Without a Supabase
 * configuration every call answers `not_authenticated`; a session chunk that fails to load
 * (offline) rejects, so the caller can try again later.
 */
export async function connectedSafetyApi(
  env: SupabaseEnv | null = supabaseEnv(),
): Promise<SafetyApi> {
  if (env === null) return unavailableSafetyApi()
  const { supabaseClient } = await import('./supabaseAuth')
  const client = supabaseClient(env)
  // The typed client's rpc() is generic over the schema's functions; the API validates every
  // answer itself, so functions are called through the untyped port.
  const rpc = client as unknown as RpcTransport
  return createSafetyApi({
    rpc: (fn, args) => rpc.rpc(fn, args),
    openNotices: () =>
      client
        .from('account_notices')
        .select('id, kind, reason, ends_at, created_at, sanction_id')
        .is('acknowledged_at', null)
        .order('created_at', { ascending: true })
        .limit(20),
  })
}

/**
 * A SafetyApi that connects on its first call and reuses the connection, so a player surface can
 * hold one without loading supabase-js until the player acts. A failed connection answers
 * `unknown` and is tried again on the next call.
 */
export function lazySafetyApi(connect: () => Promise<SafetyApi> = connectedSafetyApi): SafetyApi {
  let pending: Promise<SafetyApi> | undefined
  const api = async (): Promise<SafetyApi> => {
    pending ??= connect()
    try {
      return await pending
    } catch {
      pending = undefined
      return unavailableSafetyApi('unknown')
    }
  }
  return {
    block: async (target) => (await api()).block(target),
    unblock: async (target, undoId) => (await api()).unblock(target, undoId),
    mute: async (target) => (await api()).mute(target),
    unmute: async (target) => (await api()).unmute(target),
    listBlocks: async () => (await api()).listBlocks(),
    listMutes: async () => (await api()).listMutes(),
    report: async (input) => (await api()).report(input),
    openNotices: async () => (await api()).openNotices(),
    acknowledgeNotice: async (id) => (await api()).acknowledgeNotice(id),
    appeal: async (noticeId, body) => (await api()).appeal(noticeId, body),
  }
}

/** The safety API the game's player surfaces share. */
export const safetyApi: SafetyApi = lazySafetyApi()
