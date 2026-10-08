'use client'

import { useEffect } from 'react'
import { lazyIsland } from '@/components/overlay/lazyIsland'
import { useSafetyToast } from '@/state/safetyToast'

// DEC-11: the shell carries only this mount and the tiny toast store. The toast with its copy
// loads the first time a block, mute or report shows one.
const SafetyToast = lazyIsland(() => import('./SafetyToast').then((module) => module.SafetyToast), {
  zone: 'toast',
  labelKey: 'loading.safety',
  quiet: true,
})

/**
 * The toast zone's safety slot (S18b): nothing until a safety action shows a toast. In builds
 * with test hooks it also installs `window.__cloutcityTest.safety` from its own chunk, which
 * mounts PlayerActions for a fake player (no live player surfaces exist before S29).
 */
export function SafetyToastMount() {
  const toast = useSafetyToast()

  useEffect(() => {
    // Inlined at build time (next.config.ts): production builds drop the hook entirely.
    if (process.env.NEXT_PUBLIC_TEST_HOOKS !== '1') return
    void import('./safetyTestHook').then((module) => module.installSafetyTestHook())
  }, [])

  return toast === null ? null : <SafetyToast />
}
