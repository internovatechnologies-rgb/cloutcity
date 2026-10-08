/**
 * Service worker steps of the `e2e:perf` specs (S04e): when the app registers its worker, the
 * tier warm, and which requests before playable reached the network.
 */
import type { BrowserContext, Page, Request } from '@playwright/test'
import type { QualityTier } from '@/lib/data/schemas/config'

/** User Timing mark the init script below sets when the page calls `register()`. */
export const SW_REGISTER_MARK = 'e2e:sw-register'

/**
 * Marks the moment the page first asks to register a service worker, so a spec can check it
 * came after the map was playable. Injected by the test; the app has no such mark.
 */
export async function markServiceWorkerRegistration(page: Page): Promise<void> {
  await page.addInitScript((mark) => {
    const container = globalThis.ServiceWorkerContainer?.prototype
    if (container === undefined) return
    const register = container.register
    container.register = function (this: ServiceWorkerContainer, ...args) {
      if (performance.getEntriesByName(mark, 'mark').length === 0) performance.mark(mark)
      return register.apply(this, args)
    }
  }, SW_REGISTER_MARK)
}

/** The registration mark's time since navigation start, once it exists (bounded by `timeoutMs`). */
export async function registrationMarkMs(page: Page, timeoutMs: number): Promise<number> {
  await page.waitForFunction(
    (mark) => performance.getEntriesByName(mark, 'mark').length > 0,
    SW_REGISTER_MARK,
    { polling: 100, timeout: timeoutMs },
  )
  return page.evaluate(
    (mark) => Math.round(performance.getEntriesByName(mark, 'mark')[0]?.startTime ?? -1),
    SW_REGISTER_MARK,
  )
}

/**
 * Asks the controlling worker to warm `tier` (the app's own CC_WARM_TIER message, src/sw/sw.ts)
 * and waits for its report, so a warm load starts with the tier's districts on the device.
 */
export async function warmTier(
  page: Page,
  tier: QualityTier,
): Promise<{ cached: number; failed: number }> {
  return page.evaluate(
    (warmTier) =>
      new Promise<{ cached: number; failed: number }>((resolve, reject) => {
        const worker = navigator.serviceWorker.controller
        if (worker === null) {
          reject(new Error('no controlling service worker'))
          return
        }
        const channel = new MessageChannel()
        channel.port1.onmessage = (event: MessageEvent<{ cached: number; failed: number }>) =>
          resolve(event.data)
        worker.postMessage({ type: 'CC_WARM_TIER', tier: warmTier }, [channel.port2])
      }),
    tier,
  )
}

interface SeenRequest {
  readonly at: number
  readonly request: Request
}

/**
 * Records same-origin requests from a page and from its service worker, so a spec can list the
 * ones made before playable that went to the network: page requests the worker did not answer,
 * and the worker's own fetches. The browser's update check of the worker script is not one.
 */
export function watchNetwork(context: BrowserContext, page: Page, origin: string) {
  const seen: SeenRequest[] = []
  const onRequest = (request: Request) => {
    const url = new URL(request.url())
    if (url.origin !== origin) return
    if (request.serviceWorker() === null) {
      // Worker requests have no frame; anything else must come from the measured page.
      let fromPage = false
      try {
        fromPage = request.frame().page() === page
      } catch {
        fromPage = false
      }
      if (!fromPage) return
    }
    seen.push({ at: Date.now(), request })
  }
  context.on('request', onRequest)
  return {
    stop: () => context.off('request', onRequest),
    /** Requests started before `untilWallMs` that reached the network, as `[source] path`. */
    async networkBefore(untilWallMs: number): Promise<string[]> {
      const found: string[] = []
      for (const { at, request } of seen) {
        if (at > untilWallMs) continue
        const url = new URL(request.url())
        const path = `${url.pathname}${url.search}`
        if (request.serviceWorker() !== null) {
          if (url.pathname !== '/serwist/sw.js') found.push(`[worker] ${path}`)
          continue
        }
        const response = await request.response().catch(() => null)
        if (response?.fromServiceWorker() !== true) found.push(`[page] ${path}`)
      }
      return found
    },
  }
}
