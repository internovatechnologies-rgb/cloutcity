/**
 * The player's own profile and handle (S18a), for the Me panel: `get_my_profile`,
 * `check_handle` and `set_handle`, each answer validated with zod/mini. The handle is sent
 * exactly as the form previewed it (GR-6); the server only accepts or refuses it.
 *
 * supabase-js loads lazily: {@link connectedProfileApi} imports the session module only when
 * the Me panel asks, after the guest is online.
 */
import * as z from 'zod/mini'
import {
  HANDLE_CHECK_STATUSES,
  MyProfileSchema,
  type HandleCheckStatus,
  type MyProfile,
} from '@/lib/forms/handle'
import { supabaseEnv, type SupabaseEnv } from './env'
import { callRpc, failure, oneRow, type ApiResult, type RpcTransport } from './rpc'

export interface ProfileApi {
  getMyProfile(): Promise<ApiResult<MyProfile>>
  /** Whether `handle` is free for this player (rate limited by the server). */
  checkHandle(handle: string): Promise<ApiResult<HandleCheckStatus>>
  /** Sets the handle exactly as given and returns the updated profile. */
  setHandle(handle: string): Promise<ApiResult<MyProfile>>
}

const ProfileRowSchema = oneRow(MyProfileSchema)
const HandleCheckSchema = z.enum(HANDLE_CHECK_STATUSES)

export function createProfileApi(transport: RpcTransport): ProfileApi {
  return {
    getMyProfile: () => callRpc(transport, 'get_my_profile', {}, ProfileRowSchema),
    checkHandle: (handle) =>
      callRpc(transport, 'check_handle', { p_handle: handle }, HandleCheckSchema),
    setHandle: (handle) => callRpc(transport, 'set_handle', { p_handle: handle }, ProfileRowSchema),
  }
}

/** A ProfileApi whose every call answers `code` (no configuration in this build). */
export function unavailableProfileApi(
  code: 'not_authenticated' | 'unknown' = 'not_authenticated',
): ProfileApi {
  const fail = () => Promise.resolve(failure(code))
  return { getMyProfile: fail, checkHandle: fail, setHandle: fail }
}

/**
 * The profile API on the guest's own session, loading supabase-js on first use. Without a
 * Supabase configuration every call answers `not_authenticated`.
 */
export async function connectedProfileApi(
  env: SupabaseEnv | null = supabaseEnv(),
): Promise<ProfileApi> {
  if (env === null) return unavailableProfileApi()
  try {
    const { supabaseClient } = await import('./supabaseAuth')
    // The typed client's rpc() is generic over the schema's functions; the API validates every
    // answer itself, so it is called through the untyped port.
    return createProfileApi(supabaseClient(env) as unknown as RpcTransport)
  } catch {
    // The session chunk failed to load (offline): the same as no network.
    return unavailableProfileApi('unknown')
  }
}
