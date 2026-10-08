import { expect, test } from './fixtures/test'

interface ManifestIcon {
  src: string
  sizes: string
  type: string
  purpose?: string
}

test.describe('PWA manifest and installability', () => {
  test('serves a manifest with the app name, display mode and icons', async ({ page, request }) => {
    await page.goto('/')
    const href = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(href).toBe('/manifest.webmanifest')

    const response = await request.get(href ?? '')
    expect(response.ok()).toBe(true)
    const manifest = (await response.json()) as Record<string, unknown>
    expect(manifest).toMatchObject({
      name: 'Clout City: NYC',
      short_name: 'Clout City',
      start_url: '/',
      display: 'standalone',
    })

    const icons = manifest.icons as ManifestIcon[]
    for (const size of ['192x192', '512x512']) {
      expect(icons.some((icon) => icon.sizes === size && icon.type === 'image/png')).toBe(true)
    }
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true)

    for (const icon of icons) {
      const image = await request.get(icon.src)
      expect(image.ok(), icon.src).toBe(true)
      expect(image.headers()['content-type']).toBe('image/png')
      // PNG IHDR holds width and height as big-endian uint32 at bytes 16 and 20.
      const body = await image.body()
      const [w, h] = icon.sizes.split('x').map(Number)
      expect([body.readUInt32BE(16), body.readUInt32BE(20)], icon.src).toEqual([w, h])
    }
  })

  test('Chromium reports no installability errors', async ({ page }) => {
    await page.goto('/')
    const cdp = await page.context().newCDPSession(page)
    // The manifest is fetched asynchronously after load; wait until Chromium has parsed it.
    await expect
      .poll(async () => (await cdp.send('Page.getAppManifest')).url, { timeout: 10_000 })
      .toContain('/manifest.webmanifest')
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
    expect(installabilityErrors).toEqual([])
  })

  test('locks the viewport to the device width with safe-area support', async ({ page }) => {
    await page.goto('/')
    const content = await page.locator('meta[name="viewport"]').getAttribute('content')
    expect(content).toContain('width=device-width')
    expect(content).toContain('initial-scale=1')
    expect(content).toContain('viewport-fit=cover')

    const lock = await page.evaluate(() => {
      const html = getComputedStyle(document.documentElement)
      return {
        overflow: html.overflow,
        overscroll: html.overscrollBehaviorY,
        touch: html.touchAction,
      }
    })
    expect(lock).toEqual({ overflow: 'hidden', overscroll: 'none', touch: 'manipulation' })
  })
})
