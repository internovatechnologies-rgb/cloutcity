import type { BrowserContext, Page } from '@playwright/test'
import { expect } from '../fixtures/test'

// S04e helpers for specs that opt in with `test.use({ serviceWorkers: 'allow' })`.

export const SERVICE_WORKER_PATH = '/serwist/sw.js'

/**
 * Waits until the app has registered its worker and the worker is active (installed, so the
 * precache is complete). The app registers once the map is playable and the browser is idle.
 */
export async function waitForActiveWorker(
  page: Page,
): Promise<{ scope: string; scriptURL: string }> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return { scope: registration.scope, scriptURL: registration.active?.scriptURL ?? '' }
  })
}

/** Reloads and waits until the worker controls the page (it never claims open pages). */
export async function reloadControlled(page: Page): Promise<void> {
  await page.reload()
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
}

/** Every cache the page's origin holds, with the URLs stored in each. */
export async function cacheContents(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const result: Record<string, string[]> = {}
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      result[name] = (await cache.keys()).map((request) => request.url)
    }
    return result
  })
}

export const QUALITY_TIERS = ['low', 'mid', 'high'] as const
export type Tier = (typeof QUALITY_TIERS)[number]

const WARM_URL = /"(\/geo\/(?:districts|blocks)\/(low|mid|high)\b[^"]*\?v=[0-9a-f]+)"/g

/**
 * Each tier's warm list as the served worker carries it (src/server/pwa/revision.ts bakes in
 * `districtAssetUrls(tier)`): the district and block URLs, versioned.
 */
export function warmUrlsFromWorker(source: string): Record<Tier, string[]> {
  const result: Record<Tier, string[]> = { low: [], mid: [], high: [] }
  for (const match of source.matchAll(WARM_URL)) {
    const [, url = '', tier = 'low'] = match
    const list = result[tier as Tier]
    if (!list.includes(url)) list.push(url)
  }
  return result
}

/** The URLs (path and query) stored in the worker's versioned geo cache. */
export async function geoCacheUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      if (!name.startsWith('cc-geo-')) continue
      for (const request of await (await caches.open(name)).keys()) {
        const url = new URL(request.url)
        urls.push(`${url.pathname}${url.search}`)
      }
    }
    return urls
  })
}

/** Seeds the Graphics setting before the page loads (src/state/quality.ts). */
export async function seedQualityOverride(page: Page, tier: Tier): Promise<void> {
  await page.addInitScript((override) => {
    localStorage.setItem('cloutcity:quality', JSON.stringify({ state: { override }, version: 1 }))
  }, tier)
}

/** True once a console record from the app logger carries `msg`. */
export function waitForLog(page: Page, msg: string) {
  return page.waitForEvent('console', {
    predicate: async (message) => {
      const value = (await message
        .args()[0]
        ?.jsonValue()
        .catch(() => null)) as {
        msg?: unknown
      } | null
      return value?.msg === msg
    },
  })
}

/**
 * Makes the worker the page installs first an "older build": the served script plus a trailing
 * comment, so the real script differs from it byte for byte. Call before the first page load;
 * the returned function stops the rewrite, after which the browser's next update check
 * (`registration.update()`) finds the real script as a new build.
 *
 * It cannot work the other way round (route the update check to a changed script): with a route
 * on the worker script in place, the update check of an installed worker never reaches the route
 * or the network (Playwright 1.63, Chromium; seen with the request log), so no new worker
 * installs and the update notice never shows.
 */
export async function installOlderBuild(context: BrowserContext): Promise<() => Promise<void>> {
  const pattern = `**${SERVICE_WORKER_PATH}`
  await context.route(pattern, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, body: `${await response.text()}\n// older build\n` })
  })
  return () => context.unroute(pattern)
}

/** Asks the browser to check for a new worker and waits until one is installed and waiting. */
export async function updateToWaitingWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update()
  })
  await expect
    .poll(() =>
      page.evaluate(
        async () => ((await navigator.serviceWorker.getRegistration())?.waiting ?? null) !== null,
      ),
    )
    .toBe(true)
}
