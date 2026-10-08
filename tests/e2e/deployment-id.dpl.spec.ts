import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { reloadControlled, waitForActiveWorker } from './helpers/serviceWorker'

// F1: with Vercel Skew Protection (NEXT_DEPLOYMENT_ID) every build asset URL carries `?dpl=`.
// Run by `npm run e2e:dpl` only (playwright.dpl.config.ts builds with the id set). The precache
// ignores the parameter and the chunk route caches without it, so the assets load offline.

test.use({ serviceWorkers: 'allow' })

test('build assets carry the deployment id and the worker serves them offline', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await waitForWelcomeGate(page)
  const scripts = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map((s) => s.src),
  )
  const chunks = scripts.filter((src) => new URL(src).pathname.startsWith('/_next/static/chunks/'))
  expect(chunks.length).toBeGreaterThan(0)
  // The variant is only meaningful if Next really added the id (playwright.dpl.config.ts).
  for (const src of chunks) expect(new URL(src).searchParams.get('dpl'), src).toBe('dpl_e2e')

  await waitForActiveWorker(page)
  await reloadControlled(page)
  await context.setOffline(true)
  const statuses = await page.evaluate(
    async (urls) => Promise.all(urls.map(async (url) => (await fetch(url)).status)),
    chunks,
  )
  expect(statuses.every((status) => status === 200)).toBe(true)
  await context.setOffline(false)
})
