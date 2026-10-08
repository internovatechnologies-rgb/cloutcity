import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test, type ExpectedConsoleMessage } from './fixtures/test'

// S04a failure paths: a failed or invalid geo download and a device without WebGL leave the
// shell usable over the static background, with the scene status "error" and the error copy.
// The full no-WebGL path (the Places panel) is S04c.

const ROOT = join(import.meta.dirname, '../..')
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as T

/**
 * A copy string as players see it: the active slang pack over base, both from the key's
 * namespace directory (src/lib/copy).
 */
function copyText(key: string): string {
  const { slangPack } = readJson<{ slangPack: string }>('data/config/copy.json')
  const dir = `data/copy/${key.split('.')[0]}`
  const packFile = join(ROOT, dir, `${slangPack}.json`)
  const pack = existsSync(packFile)
    ? readJson<{ strings: Record<string, string> }>(`${dir}/${slangPack}.json`)
    : { strings: {} as Record<string, string> }
  const base = readJson<{ strings: Record<string, string> }>(`${dir}/base.json`)
  const text = pack.strings[key] ?? base.strings[key]
  if (text === undefined) throw new Error(`no copy for ${key}`)
  return text
}

/** The one warning the scene logs on purpose (src/scene/SceneErrorBoundary.tsx). */
const SCENE_FAILED_MSG = '3D scene failed to start; showing the static map background'
const READY_TIMEOUT_MS = 30_000

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Exactly one structured logger record (src/lib/log.ts) with this message and exactly this
 * context: the whole record is matched, so it carries the failure reason and never the error
 * message or payload text.
 */
function sceneWarning(context: string): ExpectedConsoleMessage {
  return {
    type: 'warning',
    text: new RegExp(
      `^\\{"level":"warn","msg":"${escape(SCENE_FAILED_MSG)}","time":"[^"]+","correlationId":"[^"]+","context":${context}\\}$`,
    ),
    count: 1,
  }
}

/** Chromium's own console line for a 500 response (unavoidable for a failed fetch). */
const FAILED_RESOURCE_500: ExpectedConsoleMessage = {
  type: 'error',
  text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
}

async function expectSceneErrorWithUsableShell(page: Page, copyKey: string): Promise<void> {
  const root = page.locator('[data-scene-root]')
  await expect(root).toHaveAttribute('data-scene-status', 'error', { timeout: READY_TIMEOUT_MS })
  await expect(page.getByRole('status').filter({ hasText: copyText(copyKey) })).toBeVisible()
  await expect(page.getByRole('img', { name: '3D map of New York City' })).toHaveCount(0)
  await expect(page.locator('canvas')).toHaveCount(0)

  // The shell still works: tabs switch, the attribution stays visible.
  const me = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Me' })
  await me.click()
  await expect(me).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('[data-map-attribution]')).toBeVisible()
}

test.describe('3D city scene failure paths', () => {
  test.describe('a geo download answering 500', () => {
    // Wrapped as [list, options]: a bare two-entry array reads as a fixture tuple.
    test.use({
      expectedConsole: [
        [sceneWarning('\\{"reason":"geo-http","status":500\\}'), FAILED_RESOURCE_500],
        { scope: 'test' },
      ],
    })

    test('shows the load error status and keeps the shell', async ({ page }) => {
      await page.route('**/geo/base*', (route) =>
        route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }),
      )
      await page.goto('/')
      await expectSceneErrorWithUsableShell(page, 'map.error.load')
    })
  })

  test.describe('an invalid JSON geo body', () => {
    test.use({ expectedConsole: [sceneWarning('\\{"reason":"geo-json"\\}')] })

    test('shows the load error status and keeps the shell', async ({ page }) => {
      await page.route('**/geo/base*', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"format":' }),
      )
      await page.goto('/')
      await expectSceneErrorWithUsableShell(page, 'map.error.load')
    })
  })

  test.describe('a well-formed JSON body that fails the schema', () => {
    // Only the failing paths are logged (dot-separated names), never the payload.
    test.use({
      expectedConsole: [
        sceneWarning(
          '\\{"reason":"geo-invalid","paths":\\["[a-z.()0-9]+"(?:,"[a-z.()0-9]+"){0,2}\\]\\}',
        ),
      ],
    })

    test('shows the load error status and keeps the shell', async ({ page }) => {
      await page.route('**/geo/base*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ format: 'cc-geo-base-v1', land: { boroughs: [] } }),
        }),
      )
      await page.goto('/')
      await expectSceneErrorWithUsableShell(page, 'map.error.load')
    })
  })

  test.describe('a device without WebGL', () => {
    test.use({ expectedConsole: [sceneWarning('\\{"reason":"no-webgl"\\}')] })

    test('shows the device error status and keeps the shell', async ({ page }) => {
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          type: string,
          ...rest: unknown[]
        ) {
          if (/webgl/i.test(type)) return null
          return (original as (...a: unknown[]) => unknown).call(this, type, ...rest)
        } as typeof HTMLCanvasElement.prototype.getContext
      })
      await page.goto('/')
      await expectSceneErrorWithUsableShell(page, 'map.error.device')
    })
  })
})
