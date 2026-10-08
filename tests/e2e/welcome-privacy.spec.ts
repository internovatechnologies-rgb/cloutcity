import type { BrowserContext, Page, Request } from '@playwright/test'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import {
  T0,
  YEAR,
  answerWelcomeCard,
  captureConsole,
  lockDialog,
  supabaseStorageKeys,
  trackCrossOriginRequests,
  welcomeDialog,
  type WelcomeAnswers,
} from './fixtures/welcome'

// S05a, CLAUDE.md "Age": the birth year is never stored, logged or sent, on any path. A guest
// session starts only after a passing attestation, exactly once; never for an under-age answer.

test.use({ onboarding: 'fresh' })

/** Everything the page could have kept: web storage, cookies, IndexedDB and Cache Storage. */
async function everythingStored(page: Page, context: BrowserContext): Promise<string> {
  const inPage = await page.evaluate(async () => {
    const dump = (storage: Storage) =>
      Object.keys(storage).map((key) => `${key}=${storage.getItem(key) ?? ''}`)
    const databases: string[] = []
    for (const info of await indexedDB.databases()) {
      if (info.name === undefined) continue
      const name = info.name
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name)
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error ?? new Error('open failed'))
      })
      for (const storeName of Array.from(db.objectStoreNames)) {
        const all = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(storeName).objectStore(storeName).getAll()
          request.onsuccess = () => resolve(request.result as unknown[])
          request.onerror = () => reject(request.error ?? new Error('read failed'))
        })
        databases.push(`${name}/${storeName}=${JSON.stringify(all)}`)
      }
      db.close()
    }
    const caches_: string[] = []
    if ('caches' in window) {
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName)
        for (const request of await cache.keys()) caches_.push(`${cacheName}:${request.url}`)
      }
    }
    return {
      local: dump(localStorage),
      session: dump(sessionStorage),
      cookie: document.cookie,
      databases,
      caches: caches_,
    }
  })
  return JSON.stringify({ ...inPage, cookies: await context.cookies() })
}

/** Every request with its URL and body. */
function trackRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (request: Request) => {
    seen.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`)
  })
  return seen
}

/** The year as a standalone number (not part of a hash, an id or a longer number). */
const yearPattern = (year: number) => new RegExp(`(?<![\\w-])${year}(?![\\w-])`)

const PATHS: readonly { name: string; answers: WelcomeAnswers; outcome: string }[] = [
  {
    name: '18+',
    answers: { birthYear: YEAR - 31, consent: true, audio: 'Play our music' },
    outcome: 'complete',
  },
  {
    name: 'under-18',
    answers: { birthYear: YEAR - 7, consent: true, audio: "I'll bring my own" },
    outcome: 'locked',
  },
  {
    name: 'a validation error (no consent)',
    answers: { birthYear: YEAR - 31, audio: 'Play our music' },
    outcome: 'errors',
  },
]

for (const { name, answers, outcome } of PATHS) {
  test(`${name}: the birth year is never stored, logged or sent`, async ({
    page,
    context,
    baseURL,
  }) => {
    const console = captureConsole(page)
    const requests = trackRequests(page)
    const crossOrigin = trackCrossOriginRequests(page, baseURL)
    await page.clock.setFixedTime(T0)
    await page.goto('/')
    await expect(welcomeDialog(page)).toBeVisible()

    await answerWelcomeCard(page, answers)
    if (outcome === 'complete') await expect(page.getByRole('dialog')).toHaveCount(0)
    if (outcome === 'locked') await expect(lockDialog(page)).toBeVisible()
    if (outcome === 'errors') {
      await expect(welcomeDialog(page).getByRole('checkbox')).toHaveAttribute(
        'aria-invalid',
        'true',
      )
    }
    // Let late effects and log calls land, then reload so boot-time code runs too.
    await page.reload()
    await waitForWelcomeGate(page)
    // Let the gate's boot effect (which starts the guest session) run and log.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await console.settle()

    const year = yearPattern(answers.birthYear ?? 0)
    expect(await everythingStored(page, context)).not.toMatch(year)
    expect(console.calls.filter((call) => year.test(call.text))).toEqual([])
    expect(requests.filter((request) => year.test(request))).toEqual([])
    expect(crossOrigin).toEqual([])
    expect(await supabaseStorageKeys(page)).toEqual([])

    const sessionLogs = console.calls.filter((call) => /guest session/i.test(call.text))
    if (outcome === 'complete') {
      // Once on completion, once on the boot after reload (a new page, a new session hook).
      expect(
        sessionLogs.filter((call) => call.text.includes('Guest session started')),
      ).toHaveLength(2)
      expect(sessionLogs.filter((call) => call.text.includes('Not starting'))).toEqual([])
    } else {
      // Under age or not yet valid: the session hook is never even called.
      expect(sessionLogs).toEqual([])
    }
  })
}

test('the year scanner sees a stored year (self-check)', async ({ page, context }) => {
  await page.goto('/')
  await page.evaluate((year) => {
    sessionStorage.setItem('probe', JSON.stringify({ birthYear: year }))
  }, YEAR - 31)
  expect(await everythingStored(page, context)).toMatch(yearPattern(YEAR - 31))
})
