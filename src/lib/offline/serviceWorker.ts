/**
 * Registers the service worker (S04e) from the lazily loaded offline-support chunk, once the map
 * is playable and the browser is idle (src/components/offline/OfflineSupportMount.tsx).
 *
 * - Production builds register /serwist/sw.js. A new build waits (the worker never skips
 *   waiting on its own); `onUpdate` lets the page offer the update, and `applyUpdate()`
 *   activates it (Serwist's SKIP_WAITING message) and reloads this tab once it is active.
 * - Another tab can take the update first (F2): the waiting worker activates and takes control of
 *   this tab too, which still runs the old build. The notice stays (it is told again, with the
 *   same worker), and `applyUpdate()` then just reloads into the new build.
 * - Each update carries the id of its worker, so putting one off ("Later") does not hide a newer
 *   build that arrives later in the session (F6).
 * - Development builds unregister any worker left from a production run on the same origin, so
 *   `next dev` never serves stale precached chunks.
 *
 * Offline support is an enhancement: no service worker support, a refused registration (private
 * modes, blocked storage, test browsers) or a failed script fetch are expected and logged at
 * info; play goes on without it.
 */
import { Serwist } from '@serwist/window'
import { log } from '@/lib/log'

export const SERVICE_WORKER_URL = '/serwist/sw.js'
export const SERVICE_WORKER_SCOPE = '/'

/** Identifies one new build's worker for this page's lifetime (1, 2, ... in order of arrival). */
export type UpdateId = number

export interface OfflineSupportOptions {
  /** True in production builds (`process.env.NODE_ENV === 'production'`). */
  readonly production: boolean
  /**
   * Called when a new build's worker is installed and waiting, or when one another tab activated
   * now controls this (older) page. Called again for the same worker with the same id.
   */
  readonly onUpdate: (id: UpdateId) => void
}

export interface OfflineSupportHandle {
  /**
   * Activates the waiting worker and reloads once it is active; when another tab already
   * activated it (it controls this page), reloads at once.
   */
  applyUpdate(): void
}

/** Ids of the new builds' workers this page has seen; the same worker keeps its id. */
export function updateIds(): (worker: ServiceWorker) => UpdateId {
  const ids = new WeakMap<ServiceWorker, UpdateId>()
  let next = 0
  return (worker) => {
    let id = ids.get(worker)
    if (id === undefined) {
      next += 1
      id = next
      ids.set(worker, id)
    }
    return id
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

async function unregisterAll(container: ServiceWorkerContainer): Promise<void> {
  const registrations = await container.getRegistrations()
  await Promise.all(registrations.map((registration) => registration.unregister()))
  if (registrations.length > 0) {
    log.info('Removed service workers in a development build', { count: registrations.length })
  }
}

export async function startOfflineSupport(
  options: OfflineSupportOptions,
): Promise<OfflineSupportHandle | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    log.info('Offline support unavailable: no service worker support')
    return null
  }
  const container = navigator.serviceWorker
  if (!options.production) {
    await unregisterAll(container).catch((error: unknown) => {
      log.info('Could not remove service workers in a development build', {
        error: errorName(error),
      })
    })
    return null
  }

  // The worker this page loaded under (null on a first visit): a different controller later means
  // a newer build took over while this page runs the old one.
  const loadedUnder = container.controller
  const idOf = updateIds()
  const newerControls = () => container.controller !== null && container.controller !== loadedUnder
  const offer = (worker: ServiceWorker | null | undefined) => {
    if (worker != null) options.onUpdate(idOf(worker))
  }

  const serwist = new Serwist(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE })
  serwist.addEventListener('waiting', (event) => offer(event.sw ?? registration?.waiting))
  // Another tab's update (F2): Serwist reports the controller change and the external worker's
  // activation; either way, if the new worker controls this page, the notice stays actionable.
  serwist.addEventListener('controlling', () => {
    if (newerControls()) offer(container.controller)
  })
  serwist.addEventListener('activated', (event) => {
    if (event.isExternal && newerControls()) offer(container.controller)
  })
  let registration: ServiceWorkerRegistration | undefined
  try {
    // The page has loaded and gone idle by now, so there is no load event to wait for.
    registration = await serwist.register({ immediate: true })
  } catch (error: unknown) {
    log.info('Offline support unavailable: the service worker did not register', {
      error: errorName(error),
    })
    return null
  }
  if (registration === undefined) {
    log.info('Offline support unavailable: the service worker did not register')
    return null
  }
  const current = registration
  // Serwist stops following updates after the first one it thinks came from another tab, so a
  // second new build in one session would never be offered (F6); follow them here as well.
  current.addEventListener('updatefound', () => {
    const installing = current.installing
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' && current.waiting === installing) offer(installing)
    })
  })
  return {
    applyUpdate() {
      const waiting = current.waiting
      if (waiting === null) {
        // Another tab already applied it: the new worker controls this page; load its build.
        if (newerControls()) window.location.reload()
        else log.info('No service worker update to apply')
        return
      }
      // Reload once the new worker is active. Not on `controllerchange`: a page loaded before
      // any worker was active has no controller to change (the worker never claims clients).
      // Only this tab reloads; another tab's update leaves this one alone.
      waiting.addEventListener('statechange', () => {
        if (waiting.state === 'activated') window.location.reload()
      })
      waiting.postMessage({ type: 'SKIP_WAITING' })
    },
  }
}
