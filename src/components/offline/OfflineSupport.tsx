'use client'

import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useModalOpen } from '@/components/overlay/modalState'
import { copy } from '@/lib/copy'
import { log } from '@/lib/log'
import { offlineConfig } from '@/lib/offline/config'
import {
  startOfflineSupport,
  type OfflineSupportHandle,
  type UpdateId,
} from '@/lib/offline/serviceWorker'
import { readDeviceSignals, startTierWarm } from '@/lib/offline/tierWarm'
import { updateNoticeShown } from '@/lib/offline/updateNotice'
import { qualityStore, selectActiveTier } from '@/state/quality'
import { tourStore } from '@/state/tour'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/offline'

/** Runs `run` when the browser is next idle, or after `timeoutMs` at the latest. */
function whenIdle(timeoutMs: number, run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: timeoutMs })
    return () => window.cancelIdleCallback(id)
  }
  // Safari before 18.4 has no requestIdleCallback: yield one task instead.
  const id = window.setTimeout(run, 0)
  return () => window.clearTimeout(id)
}

/**
 * Offline support (S04e), loaded once the map is playable: registers the service worker when the
 * browser is idle, has it warm the quality tier's district assets once it is active (and again
 * when the tier changes; skipped under data saver and on low memory), and shows the update notice
 * in the banner zone when a new build is waiting (or another tab already applied it, F2); "Later"
 * puts off that build only (F6). The notice never covers a modal (the welcome
 * card, the Icon moment) or the first-run tour (GR-9); it waits until they are gone.
 */
export function OfflineSupport() {
  // The newest build on offer and the one put off, by worker id (F6).
  const [update, setUpdate] = useState<UpdateId | null>(null)
  const [dismissed, setDismissed] = useState<UpdateId | null>(null)
  const handle = useRef<OfflineSupportHandle | null>(null)
  const modalOpen = useModalOpen()
  const touring = useStore(tourStore, (state) => state.record?.status === 'active')

  useEffect(() => {
    let active = true
    let stopWarm = () => {}
    const cancel = whenIdle(offlineConfig.registration.idleTimeoutMs, () => {
      void startOfflineSupport({
        production: process.env.NODE_ENV === 'production',
        onUpdate: (id) => {
          if (active) setUpdate((shown) => (shown === null || id > shown ? id : shown))
        },
      }).then((started) => {
        handle.current = started
        if (!active || started === null) return
        stopWarm = startTierWarm({
          ready: navigator.serviceWorker.ready,
          quality: () => {
            const state = qualityStore.getState()
            return { tier: selectActiveTier(state), dataSaver: state.dataSaver }
          },
          subscribe: (listener) => qualityStore.subscribe(listener),
          device: () => readDeviceSignals(navigator),
          config: offlineConfig.tierWarm,
          logger: log,
        })
      })
    })
    return () => {
      active = false
      cancel()
      stopWarm()
    }
  }, [])

  if (!updateNoticeShown({ update, dismissed, modalOpen, touring })) return null

  return (
    <div
      data-cc-notice="update"
      role="status"
      className="mx-2 flex h-full items-center gap-2 rounded-2xl border border-taxi glass px-3 text-sm text-fg shadow-lg"
    >
      <p className="line-clamp-2 min-w-0 flex-1">{copy('offline.update.message')}</p>
      <button
        type="button"
        onClick={() => handle.current?.applyUpdate()}
        className="min-h-11 shrink-0 rounded-xl bg-taxi px-3 font-semibold text-on-taxi focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {copy('offline.update.action')}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(update)}
        className="min-h-11 shrink-0 rounded-xl bg-raised px-3 font-semibold text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {copy('offline.update.dismiss')}
      </button>
    </div>
  )
}
