/**
 * The narrow port the feature APIs (profileApi.ts, safetyApi.ts) call the database through, and
 * the one place an RPC's answer is checked. No Supabase import: the browser reaches supabase-js
 * only through `import('./supabaseAuth')`, and tests pass an in-memory fake.
 *
 * Every answer is validated with zod/mini (an RPC that returns `table (...)` answers with an
 * array of rows), and every failure becomes one machine code: an RPC_ERRORS code the server
 * raised, or `unknown` (no network, an unexpected answer). Nothing here logs: callers log the
 * code only, never the arguments (a report note, a handle someone typed).
 */
import * as z from 'zod/mini'
import { parseRpcError, type RpcErrorCode } from './attestation'

/** What a PostgREST call answers: data or an error, never both. */
export interface RpcResponse {
  readonly data: unknown
  readonly error: unknown
}

/** Calls a database function by name, as `supabase.rpc(fn, args)` does. */
export interface RpcTransport {
  rpc(fn: string, args?: Readonly<Record<string, unknown>>): PromiseLike<RpcResponse>
}

export type ApiErrorCode = RpcErrorCode | 'unknown'

export type ApiResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly code: ApiErrorCode }

/** A failed result with `code`. */
export function failure(code: ApiErrorCode): { readonly ok: false; readonly code: ApiErrorCode } {
  return { ok: false, code }
}

/** Validates `response` with `schema`; an error or an unexpected shape is a failure. */
export function readResponse<S extends z.ZodMiniType>(
  response: RpcResponse,
  schema: S,
): ApiResult<z.infer<S>> {
  if (response.error !== null && response.error !== undefined) {
    return failure(parseRpcError(response.error))
  }
  const parsed = schema.safeParse(response.data)
  return parsed.success ? { ok: true, data: parsed.data } : failure('unknown')
}

/** Calls `fn` and validates its answer. Never throws: a thrown fetch is `unknown`. */
export async function callRpc<S extends z.ZodMiniType>(
  transport: RpcTransport,
  fn: string,
  args: Readonly<Record<string, unknown>>,
  schema: S,
): Promise<ApiResult<z.infer<S>>> {
  try {
    return readResponse(await transport.rpc(fn, args), schema)
  } catch {
    return failure('unknown')
  }
}

/** The one row a `returns table (...)` function answers with. */
export function oneRow<S extends z.ZodMiniType>(row: S) {
  return z.pipe(
    z.tuple([row]),
    z.transform((rows) => rows[0]),
  )
}

/** A `returns void` function: PostgREST answers with no body, so there is nothing to check. */
export const VoidSchema = z.unknown()
