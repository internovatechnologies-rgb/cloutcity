'use client'

import { lazyIsland } from '@/components/overlay/lazyIsland'
import { useIconMomentPending, usePrestigeConfirmRequested } from '@/state/iconMoment'

// DEC-11: the shell carries only this mount and the tiny iconMoment signal. The victory screen,
// with the game store, engine and goals copy, is a feature island loaded only when the moment
// comes, with its loading state in the modal zone.
const IconMoment = lazyIsland(() => import('./IconMoment').then((module) => module.IconMoment), {
  zone: 'modal',
  labelKey: 'loading.iconMoment',
})

/**
 * The modal slot's Icon moment (S15): nothing until the HUD's live island reports that the run
 * reached the victory goal and the player has not seen the moment yet, or the Goals panel's
 * Prestige entry asks for the prestige confirm on its own.
 */
export function IconMomentMount() {
  const pending = useIconMomentPending()
  const confirm = usePrestigeConfirmRequested()
  if (pending) return <IconMoment />
  return confirm ? <IconMoment confirmOnly /> : null
}
