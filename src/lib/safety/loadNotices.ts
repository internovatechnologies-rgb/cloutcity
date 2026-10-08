/**
 * Loads the moderator notices the player has not acknowledged yet (S18b) into the shell's
 * notice store, so the notice modal shows at session start. Called by the guest session once it
 * is connected (src/state/session.ts). A failure is expected (offline) and only logged: the
 * notices show again next session.
 */
import { log, type Logger } from '@/lib/log'
import { safetyApi as defaultApi, type SafetyApi } from '@/lib/supabase/safetyApi'
import { setAccountNotices } from '@/state/accountNotices'

export async function loadAccountNotices(
  api: SafetyApi = defaultApi,
  logger: Logger = log,
): Promise<void> {
  const result = await api.openNotices()
  if (!result.ok) {
    logger.info('Account notices did not load; they show next session', { code: result.code })
    return
  }
  if (result.data.length > 0) setAccountNotices(result.data, api)
}
