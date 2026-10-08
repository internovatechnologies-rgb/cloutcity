'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { PANEL_BUTTON, PanelDialog } from '@/components/hud/PanelDialog'
import { BlockedMutedList } from '@/components/safety/BlockedMutedList'
import { copy, copyParts, type CopyKey } from '@/lib/copy'
import type { MyProfile } from '@/lib/forms/handle'
import { connectedProfileApi, type ProfileApi } from '@/lib/supabase/profileApi'
import { safetyApi } from '@/lib/supabase/safetyApi'
import { guestSessionStore, type GuestSessionState } from '@/state/guestSession'
import { closeHudPanel } from '@/state/hudPanel'
import { HandleForm } from './HandleForm'
import { PublicCard } from './PublicCard'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/profile'

const sessionState = () => guestSessionStore.getState()

function useGuestSession(): GuestSessionState {
  return useSyncExternalStore(guestSessionStore.subscribe, sessionState, sessionState)
}

/** Why there is no online profile, in plain words. */
function offlineReasonKey(session: GuestSessionState): CopyKey {
  if (session.status === 'connecting' || session.status === 'idle') {
    return 'profile.offline.connecting'
  }
  if (session.status === 'refused') return 'profile.offline.refused'
  switch (session.reason) {
    case 'no-config':
      return 'profile.offline.noConfig'
    case 'offline':
      return 'profile.offline.offline'
    case 'rate-limited':
      return 'profile.offline.rateLimited'
    default:
      return 'profile.offline.other'
  }
}

/**
 * The honest not-connected state (S18a): a player with no server session has no handle anyone
 * can see, so the panel says so and why, instead of showing a made-up one.
 */
function NotConnected({ session }: { readonly session: GuestSessionState }) {
  return (
    <section
      data-me-offline={session.reason ?? session.status}
      aria-labelledby="me-offline-title"
      className="flex flex-col gap-1 rounded-xl bg-raised p-3"
    >
      <h3 id="me-offline-title" className="font-bold text-fg">
        {copy('profile.offline.title')}
      </h3>
      <p className="text-sm text-muted">{copy(offlineReasonKey(session))}</p>
      <p className="text-sm text-muted">{copy('profile.offline.hidden')}</p>
    </section>
  )
}

type ProfileLoad =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly api: ProfileApi; readonly profile: MyProfile }

/** The online player's card, handle form and blocked and muted lists. */
function OnlineProfile() {
  const [load, setLoad] = useState<ProfileLoad>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    void (async () => {
      const api = await connectedProfileApi()
      const result = await api.getMyProfile()
      if (!live) return
      setLoad(result.ok ? { state: 'ready', api, profile: result.data } : { state: 'failed' })
    })()
    return () => {
      live = false
    }
  }, [attempt])

  const onSaved = useCallback(
    (profile: MyProfile) =>
      setLoad((previous) => (previous.state === 'ready' ? { ...previous, profile } : previous)),
    [],
  )

  if (load.state === 'loading') {
    return (
      <p role="status" className="text-sm text-muted">
        {copy('profile.load.loading')}
      </p>
    )
  }
  if (load.state === 'failed') {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm font-semibold text-danger">
          {copy('profile.load.failed')}
        </p>
        <button
          type="button"
          onClick={() => {
            setLoad({ state: 'loading' })
            setAttempt((value) => value + 1)
          }}
          className={`${PANEL_BUTTON} bg-raised text-fg`}
        >
          {copy('profile.load.retry')}
        </button>
      </div>
    )
  }
  return (
    <>
      <PublicCard profile={load.profile} />
      <HandleForm api={load.api} profile={load.profile} onSaved={onSaved} />
      <BlockedMutedList api={safetyApi} />
    </>
  )
}

function ConductLink() {
  return (
    <p className="text-sm text-muted">
      {copyParts('profile.conduct.text').map((part, index) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <Link
            key={index}
            href="/conduct"
            className="font-semibold text-taxi-ink underline underline-offset-2"
          >
            {copy('profile.conduct.link')}
          </Link>
        ),
      )}
    </p>
  )
}

/**
 * The Me panel (S18a, S18b), opened by the Me tab: how other players see you, your handle, and
 * the players you blocked or muted. It needs the guest's server session; without one it says
 * why. supabase-js loads only once the player is online and the panel opens.
 */
export function MePanel() {
  const session = useGuestSession()
  return (
    <PanelDialog
      title={copy('profile.panel.title')}
      panel="me"
      feature="cc-feature:me-panel"
      onClose={closeHudPanel}
      scrollBody
    >
      {session.status === 'anonymous' ? <OnlineProfile /> : <NotConnected session={session} />}
      <ConductLink />
    </PanelDialog>
  )
}
