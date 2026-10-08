'use client'

import { lazyIsland } from '@/components/overlay/lazyIsland'
import { useHasAccountNotices } from '@/state/accountNotices'

// DEC-11: the shell carries only this mount and the tiny notices store. The notice, with its
// copy and the appeal form, loads only when the session finds one (S18b).
const AccountNotices = lazyIsland(
  () => import('./AccountNotices').then((module) => module.AccountNotices),
  { zone: 'modal', labelKey: 'loading.notices' },
)

/** The modal slot's moderator notices: nothing unless the player has one to read. */
export function AccountNoticesMount() {
  return useHasAccountNotices() ? <AccountNotices /> : null
}
