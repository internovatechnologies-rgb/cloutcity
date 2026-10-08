import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { copyText } from './helpers/places'
import {
  QUALITY_TIERS,
  SERVICE_WORKER_PATH,
  cacheContents,
  geoCacheUrls,
  installOlderBuild,
  reloadControlled,
  seedQualityOverride,
  updateToWaitingWorker,
  waitForActiveWorker,
  waitForLog,
  warmUrlsFromWorker,
  type Tier,
} from './helpers/serviceWorker'
import { expectStep, tourCard, tourSkip } from './helpers/tour'

// S04e: the service worker. Served uncached with a strict CSP, registered for the whole origin,
// it stores only what its policy allows (src/sw/policy.ts) and replaces old versioned caches
// when a new build takes over.

test.use({ serviceWorkers: 'allow' })

const updateNotice = (page: import('@playwright/test').Page) =>
  page.locator('[data-cc-notice="update"]')

test.describe('service worker', () => {
  test('is served uncached, with a strict CSP; versioned geo is immutable', async ({ request }) => {
    const worker = await request.get(SERVICE_WORKER_PATH)
    expect(worker.ok()).toBe(true)
    const headers = worker.headers()
    expect(headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
    expect(headers['content-security-policy']).toBe("default-src 'self'; script-src 'self'")
    expect(headers['content-type']).toMatch(/^application\/javascript/)
    // Never precaches audio (it loads only after the player's audio choice) or models (they
    // load on demand, per tier).
    const body = await worker.text()
    expect(body).not.toMatch(/url:"\/audio\//)
    expect(body).not.toMatch(/url:"\/models\//)
    expect(body).not.toMatch(/url:"[^"]*\.(?:glb|map)"/)
    // No source map: the bundle names none and none is served.
    expect(body).not.toContain('sourceMappingURL')
    expect((await request.get(`${SERVICE_WORKER_PATH}.map`)).status()).toBe(404)
    const geoVersion = /url:"\/geo\/base\?v=([0-9a-f]{12})"/.exec(body)?.[1]
    expect(geoVersion, 'the worker precaches the versioned base geo').toBeDefined()

    const geo = await request.get(`/geo/base?v=${geoVersion}`)
    expect(geo.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
    // The fallback map also renders palette and copy, which can change without the geo version.
    const fallback = await request.get(`/geo/fallback?v=${geoVersion}`)
    expect(fallback.headers()['cache-control']).not.toContain('immutable')
    // Unversioned geo is not immutable either.
    expect((await request.get('/geo/base')).headers()['cache-control']).not.toContain('immutable')
  })

  test('registers for the whole origin once the map is playable', async ({ page, baseURL }) => {
    await page.goto('/')
    await waitForWelcomeGate(page)
    const registration = await waitForActiveWorker(page)
    expect(registration.scope).toBe(`${baseURL}/`)
    expect(registration.scriptURL).toBe(`${baseURL}${SERVICE_WORKER_PATH}`)
    await reloadControlled(page)
    await expect(updateNotice(page)).toHaveCount(0)
  })

  test.describe('never-cache policy', () => {
    // The probes below request paths that do not exist on purpose; Chromium reports each 404.
    test.use({
      injectedConsoleErrors: [
        /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
      ],
    })

    test('never stores private, credentialed, failed or server responses', async ({
      page,
      context,
      baseURL,
      request,
    }) => {
      // The geo route caches only versions this build serves (F4), so the probes use the high
      // tier's real district URLs: headless Chromium is on the low tier, so neither the scene
      // nor the tier warm fetches them on its own.
      const body = await (await request.get(SERVICE_WORKER_PATH)).text()
      const [allowedUrl, authUrl, privateUrl, cookieUrl] = warmUrlsFromWorker(body).high
      const geoVersion = /url:"\/geo\/base\?v=([0-9a-f]{12})"/.exec(body)?.[1] ?? ''
      if (!allowedUrl || !authUrl || !privateUrl || !cookieUrl || geoVersion === '')
        throw new Error('the served worker names too few high-tier district URLs')
      const probes = {
        allowed: allowedUrl,
        credentialed: authUrl,
        private: privateUrl,
        cookie: cookieUrl,
        missing: `/geo/missing?v=${geoVersion}`,
      }
      // Fulfilled by the test for the worker's own fetch: proves context.route sees worker
      // requests, and that a `private` or cookie-varying response is refused.
      await context.route(`**${privateUrl}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'cache-control': 'private, max-age=60' },
          body: '{}',
        }),
      )
      await context.route(`**${cookieUrl}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { vary: 'Cookie' },
          body: '{}',
        }),
      )
      await page.goto('/')
      await waitForWelcomeGate(page)
      await waitForActiveWorker(page)
      await reloadControlled(page)

      const statuses = await page.evaluate(async (urls) => {
        const get = async (url: string, init?: RequestInit) => (await fetch(url, init)).status
        return {
          allowed: await get(urls.allowed),
          credentialed: await get(urls.credentialed, {
            headers: { Authorization: 'Bearer probe' },
          }),
          private: await get(urls.private),
          cookie: await get(urls.cookie),
          missing: await get(urls.missing),
          api: await get('/api/probe'),
          mod: await get('/mod'),
        }
      }, probes)
      expect(statuses).toMatchObject({ allowed: 200, credentialed: 200, private: 200, cookie: 200 })

      const contents = await cacheContents(page)
      const all = Object.entries(contents).flatMap(([cache, urls]) =>
        urls.map((url) => ({ cache, url: new URL(url) })),
      )
      // Positive control: an allowed versioned geo response is stored in the geo cache.
      const pathOf = (url: URL) => `${url.pathname}${url.search}`
      const allowed = all.find(({ url }) => pathOf(url) === probes.allowed)
      expect(allowed?.cache).toMatch(/^cc-geo-[0-9a-f]{12}$/)

      const refused = [probes.credentialed, probes.private, probes.cookie, probes.missing]
      for (const { cache, url } of all) {
        const where = `${cache}: ${url.href}`
        expect(url.origin, where).toBe(baseURL)
        expect(url.pathname, where).not.toMatch(/^\/(?:api|mod|serwist|og)(?:\/|$)/)
        expect(refused, where).not.toContain(pathOf(url))
        if (url.pathname.startsWith('/audio/')) expect(cache, where).toMatch(/^cc-audio-/)
      }
      // The precache holds the app shell and the offline page.
      const precache = Object.keys(contents).find((name) => name.startsWith('serwist-precache-'))
      expect(precache).toBeDefined()
      const precached = (contents[precache ?? ''] ?? []).map((url) => new URL(url).pathname)
      expect(precached).toEqual(expect.arrayContaining(['/', '/offline', '/geo/base']))
    })
  })

  test('never caches geo at a junk version, with extra parameters or as a navigation (F4)', async ({
    page,
    request,
  }) => {
    const body = await (await request.get(SERVICE_WORKER_PATH)).text()
    const geoVersion = /url:"\/geo\/base\?v=([0-9a-f]{12})"/.exec(body)?.[1] ?? ''
    expect(geoVersion).not.toBe('')
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForActiveWorker(page)
    await reloadControlled(page)
    await page.evaluate(async (version) => {
      for (const url of [
        '/geo/base?v=junk0',
        '/geo/base?v=0123456789ab',
        `/geo/base?v=${version}&x=1`,
        `/geo/fallback?x=1&v=${version}`,
      ])
        await fetch(url)
    }, geoVersion)
    for (let i = 0; i < 2; i += 1) await page.goto(`/geo/base?v=junk${i}&x=${i}`)
    // Read the caches from the last (same-origin) page: no need to boot the map again.
    const cached = await geoCacheUrls(page)
    expect(cached.filter((url) => /junk|0123456789ab|[?&]x=/.test(url))).toEqual([])
  })

  test('a new build waits for the player, then replaces old versioned caches', async ({
    page,
    context,
    checkA11y,
    request,
  }) => {
    const kept = warmUrlsFromWorker(await (await request.get(SERVICE_WORKER_PATH)).text()).high[0]
    if (kept === undefined) throw new Error('the served worker names no high-tier district URL')
    const shipNewBuild = await installOlderBuild(context)
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForActiveWorker(page)
    await shipNewBuild()
    await reloadControlled(page)

    // Caches an older build left behind, and one the current build owns.
    await page.evaluate(async (url) => {
      await (await caches.open('cc-geo-0123456789ab')).put('/geo/base?v=old', new Response('{}'))
      await (await caches.open('cc-audio-0123456789ab')).put('/audio/old.webm', new Response(''))
      await fetch(url)
    }, kept)
    const before = Object.keys(await cacheContents(page))
    const current = before.find((name) => /^cc-geo-/.test(name) && name !== 'cc-geo-0123456789ab')
    expect(current, 'the current geo cache').toBeDefined()

    // A "new build": the served worker differs from the one installed (installOlderBuild).
    await updateToWaitingWorker(page)

    // The new worker waits: nothing is swapped under the player until they choose. The page
    // registers its worker only once the map is playable and the browser is idle.
    const notice = updateNotice(page)
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(notice).toContainText(copyText('offline.update.message'))
    await checkA11y()
    expect(Object.keys(await cacheContents(page))).toContain('cc-geo-0123456789ab')

    await Promise.all([
      page.waitForEvent('load'),
      notice.getByRole('button', { name: copyText('offline.update.action') }).click(),
    ])
    await waitForWelcomeGate(page)
    await expect
      .poll(async () => Object.keys(await cacheContents(page)))
      .not.toContain('cc-geo-0123456789ab')
    const after = Object.keys(await cacheContents(page))
    expect(after).not.toContain('cc-audio-0123456789ab')
    expect(after).toContain(current)
    await expect(updateNotice(page)).toHaveCount(0)
  })

  test('an update applied in another tab leaves this tab a working Update button (F2)', async ({
    page,
    context,
  }) => {
    const shipNewBuild = await installOlderBuild(context)
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForActiveWorker(page)
    await shipNewBuild()
    await reloadControlled(page)
    const other = await context.newPage()
    await other.goto('/')
    await waitForWelcomeGate(other)
    await other.waitForFunction(() => navigator.serviceWorker.controller !== null)

    await updateToWaitingWorker(page)
    const here = updateNotice(page)
    const there = updateNotice(other)
    await expect(here).toBeVisible()
    // The other tab registers its worker only once its map is playable and the browser is idle.
    await expect(there).toBeVisible({ timeout: 30_000 })
    const action = copyText('offline.update.action')
    await Promise.all([
      other.waitForEvent('load'),
      there.getByRole('button', { name: action }).click(),
    ])
    await waitForWelcomeGate(other)

    // This tab: the worker it was offered now controls it from the other tab's tap. The notice
    // stays, and Update reloads it into the new build instead of doing nothing.
    await expect
      .poll(() =>
        page.evaluate(
          async () => ((await navigator.serviceWorker.getRegistration())?.waiting ?? null) === null,
        ),
      )
      .toBe(true)
    await expect(here).toBeVisible()
    await Promise.all([
      page.waitForEvent('load'),
      here.getByRole('button', { name: action }).click(),
    ])
    await waitForWelcomeGate(page)
    await expect(updateNotice(page)).toHaveCount(0)
    await other.close()
  })

  test('the update notice can be put off', async ({ page, context }) => {
    const shipNewBuild = await installOlderBuild(context)
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForActiveWorker(page)
    await shipNewBuild()
    await reloadControlled(page)
    await updateToWaitingWorker(page)
    const notice = updateNotice(page)
    await notice.getByRole('button', { name: copyText('offline.update.dismiss') }).click()
    await expect(notice).toHaveCount(0)
    // Still waiting: it takes over only once every tab of the old build has closed.
    expect(
      await page.evaluate(
        async () => ((await navigator.serviceWorker.getRegistration())?.waiting ?? null) !== null,
      ),
    ).toBe(true)
  })
})

test.describe('tier warm', () => {
  async function servedWarmLists(
    request: import('@playwright/test').APIRequestContext,
  ): Promise<Record<Tier, string[]>> {
    const lists = warmUrlsFromWorker(await (await request.get(SERVICE_WORKER_PATH)).text())
    for (const tier of QUALITY_TIERS) expect(lists[tier].length, tier).toBeGreaterThan(1)
    return lists
  }

  /** Waits until every URL of `tier` is in the geo cache, then checks no other tier's is. */
  async function expectWarmed(
    page: import('@playwright/test').Page,
    lists: Record<Tier, string[]>,
    tier: Tier,
  ) {
    await expect
      .poll(async () => {
        const cached = await geoCacheUrls(page)
        return lists[tier].filter((url) => !cached.includes(url))
      })
      .toEqual([])
    const cached = await geoCacheUrls(page)
    for (const other of QUALITY_TIERS.filter((t) => t !== tier)) {
      for (const url of lists[other])
        expect(cached, `${tier} must not warm ${url}`).not.toContain(url)
    }
  }

  test("warms the detected tier's district assets once the worker is active", async ({
    page,
    request,
  }) => {
    const lists = await servedWarmLists(request)
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForActiveWorker(page)
    // Headless Chromium renders on SwiftShader, which the picker puts on the low tier.
    await expectWarmed(page, lists, 'low')
  })

  test('warms the tier the Graphics setting chooses', async ({ page, request }) => {
    const lists = await servedWarmLists(request)
    await seedQualityOverride(page, 'mid')
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForActiveWorker(page)
    await expectWarmed(page, lists, 'mid')
  })

  test('never warms under a data-saver request', async ({ page, request }) => {
    const lists = await servedWarmLists(request)
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'connection', {
        configurable: true,
        get: () => ({
          saveData: true,
          effectiveType: '4g',
          addEventListener() {},
          removeEventListener() {},
        }),
      })
    })
    const skipped = waitForLog(page, 'Tier warm skipped')
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForActiveWorker(page)
    await skipped
    const cached = await geoCacheUrls(page)
    for (const tier of QUALITY_TIERS) {
      for (const url of lists[tier]) expect(cached, url).not.toContain(url)
    }
  })

  test('never warms on a low-memory device', async ({ page, request }) => {
    const lists = await servedWarmLists(request)
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'deviceMemory', {
        configurable: true,
        get: () => 1,
      })
    })
    const skipped = waitForLog(page, 'Tier warm skipped')
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForActiveWorker(page)
    await skipped
    const cached = await geoCacheUrls(page)
    for (const url of lists.low) expect(cached, url).not.toContain(url)
  })
})

test.describe('3D models', () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../data/assets/manifest.json'), 'utf8'),
  ) as { assetVersion: string; models: { tiers: Record<string, { file: string }> }[] }
  const file = Object.values(manifest.models[0]?.tiers ?? {})[0]?.file ?? ''

  test('are cached on first use in the versioned models cache, never precached', async ({
    page,
  }) => {
    expect(file).toMatch(/^\/models\/[a-z0-9-]+\.(?:low|mid|high)\.[0-9a-f]{8}\.glb$/)
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForActiveWorker(page)
    await reloadControlled(page)

    const before = await cacheContents(page)
    const precache = Object.keys(before).find((name) => name.startsWith('serwist-precache-'))
    for (const url of before[precache ?? ''] ?? []) {
      expect(new URL(url).pathname, url).not.toMatch(/^\/models\//)
    }

    const statuses = await page.evaluate(async (path) => {
      const plain = await fetch(path)
      const queried = await fetch(`${path}?probe=1`)
      return [plain.status, queried.status]
    }, file)
    expect(statuses).toEqual([200, 200])

    const contents = await cacheContents(page)
    const models = Object.entries(contents).filter(([name]) => name.startsWith('cc-models-'))
    expect(models.map(([name]) => name)).toEqual([`cc-models-${manifest.assetVersion}`])
    const stored = (models[0]?.[1] ?? []).map((url) => {
      const parsed = new URL(url)
      return `${parsed.pathname}${parsed.search}`
    })
    // The content-named file is kept; the same file with a query is not a versioned model.
    expect(stored).toContain(file)
    expect(stored).not.toContain(`${file}?probe=1`)
    for (const [name, urls] of Object.entries(contents)) {
      if (name.startsWith('cc-models-')) continue
      for (const url of urls) expect(new URL(url).pathname, `${name}: ${url}`).not.toMatch(/\.glb$/)
    }
  })
})

test.describe('update notice during the tour', () => {
  test.use({ tour: 'fresh' })

  test('waits behind the tour and shows once it is skipped', async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const shipNewBuild = await installOlderBuild(context)
    await page.goto('/')
    await waitForWelcomeGate(page)
    await expectStep(page, 'hud')
    await waitForActiveWorker(page)
    await shipNewBuild()
    await reloadControlled(page)
    await expectStep(page, 'hud')

    await updateToWaitingWorker(page)

    // A new build is waiting, but the tour holds the banner zone (GR-9).
    await expect(tourCard(page)).toBeVisible()
    await expect(updateNotice(page)).toHaveCount(0)

    await tourSkip(page).click()
    await expect(tourCard(page)).toHaveCount(0)
    await expect(updateNotice(page)).toBeVisible()
    await expect(updateNotice(page)).toContainText(copyText('offline.update.message'))
  })
})
