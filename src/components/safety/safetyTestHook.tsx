import { createRoot, type Root } from 'react-dom/client'
import type { ApiErrorCode } from '@/lib/supabase/rpc'
import type { AccountNotice, SafetyApi } from '@/lib/supabase/safetyApi'
import { clearAccountNotices, setAccountNotices } from '@/state/accountNotices'
import { createFakeSafetyApi, type FakeSafetyApi } from './fakeSafetyApi'
import { PlayerActions, type PlayerActionsLayout } from './PlayerActions'

/**
 * Test-only hook for the S18b safety tools (tests/e2e/safety-*.spec.ts), on
 * `window.__cloutcityTest.safety`. No live player surface exists before S29, so `mount` renders
 * PlayerActions for a fake player in the sheet zone, against an in-memory SafetyApi. Only builds
 * with NEXT_PUBLIC_TEST_HOOKS=1 load it (from its own chunk, see SafetyToastMount), and it
 * installs only when the page also sets `window.__CLOUTCITY_E2E__ = true` first.
 */
export interface SafetyTestHook {
  mount(options: {
    readonly handle: string
    readonly layout: PlayerActionsLayout
    readonly failures?: Readonly<Partial<Record<keyof SafetyApi, ApiErrorCode>>>
    readonly endsFriendship?: boolean
    readonly undoSeconds?: number
  }): void
  unmount(): void
  /** The fake API's calls so far, as `method:target`. */
  calls(): readonly string[]
  /** Shows moderator notices as if the session had loaded them. */
  showNotices(notices: readonly AccountNotice[]): void
}

declare global {
  interface CloutcityTestHooks {
    safety?: SafetyTestHook
  }
}

export function installSafetyTestHook(): void {
  if (window.__CLOUTCITY_E2E__ !== true) return
  let root: Root | null = null
  let host: HTMLElement | null = null
  let api: FakeSafetyApi = createFakeSafetyApi()
  const unmount = () => {
    root?.unmount()
    host?.remove()
    root = null
    host = null
  }
  const hook: SafetyTestHook = {
    mount: ({ handle, layout, failures, endsFriendship, undoSeconds }) => {
      unmount()
      api = createFakeSafetyApi({ failures, endsFriendship, undoSeconds })
      const zone = document.querySelector('[data-overlay-zone="sheet"] > div')
      if (zone === null) throw new Error('the sheet zone is not rendered')
      host = document.createElement('div')
      host.dataset.safetyHarness = ''
      host.className = 'm-2 rounded-2xl border border-line glass p-3'
      zone.append(host)
      root = createRoot(host)
      root.render(
        <PlayerActions player={{ id: `fake-${handle}`, handle }} layout={layout} api={api} />,
      )
    },
    unmount,
    calls: () => [...api.calls],
    showNotices: (notices) => {
      clearAccountNotices()
      api = createFakeSafetyApi({ notices })
      setAccountNotices(notices, api)
    },
  }
  window.__cloutcityTest = { ...window.__cloutcityTest, safety: hook }
}
