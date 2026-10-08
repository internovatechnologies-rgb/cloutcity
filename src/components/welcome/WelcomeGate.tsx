'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useModalPresence } from '@/components/overlay/modalState'
import { trapTab } from '@/components/overlay/trapTab'
import { deriveGateStatus, type GateStatus } from '@/engine/ageGate'
import { onboardingStore } from '@/state/onboarding'
import { startGuestSession } from '@/state/session'
import { AgeLockNotice } from './AgeLockNotice'
import { WelcomeCard } from './WelcomeCard'

const gateStatus = (): GateStatus => deriveGateStatus(onboardingStore.getState().record, Date.now())
// The server cannot know what this device stored; render nothing until the client reads it,
// so a returning player never sees the card flash.
const serverGateStatus = (): GateStatus => 'pending'

/**
 * The first-visit welcome card (S05a), over the already-loading map. It shows until this
 * device has a passing 18+ attestation, or the under-age lock screen while a lock holds, and
 * nothing for a returning player. There is no close button and Escape does nothing: the card is
 * the way in. Loaded as a boot island by WelcomeMount (DEC-11).
 */
export function WelcomeGate() {
  const status = useSyncExternalStore(onboardingStore.subscribe, gateStatus, serverGateStatus)
  const open = status === 'welcome' || status === 'locked'
  useModalPresence(open)
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (!open || element === null) return
    const onKeyDown = (event: KeyboardEvent) => trapTab(element, event)
    element.addEventListener('keydown', onKeyDown)
    return () => element.removeEventListener('keydown', onKeyDown)
  }, [open])

  useEffect(() => {
    const { clearExpiredLock } = onboardingStore.getState()
    clearExpiredLock(Date.now())
    // A returning player's session starts on boot; a new one's when the card is completed.
    if (onboardingStore.getState().record?.status === 'complete') startGuestSession()
  }, [])

  // Closed: an empty marker records that the boot island has decided (e2e specs wait for it
  // before driving the page, which stays inert while the island loads).
  if (!open) return <span hidden data-welcome-gate={status} />

  const ids =
    status === 'welcome'
      ? { title: 'welcome-title', description: 'welcome-intro' }
      : { title: 'age-gate-title', description: 'age-gate-body' }

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={ids.title}
      aria-describedby={ids.description}
      data-welcome-dialog={status}
      data-welcome-gate={status}
      data-cc-feature="cc-feature:welcome"
      className="pointer-events-auto max-h-full w-full max-w-[var(--overlay-sheet-max-w)] self-center overflow-y-auto overscroll-contain rounded-3xl border border-line glass p-5 shadow-2xl"
    >
      {status === 'welcome' ? (
        <WelcomeCard titleId={ids.title} introId={ids.description} />
      ) : (
        <AgeLockNotice titleId={ids.title} bodyId={ids.description} />
      )}
    </div>
  )
}
