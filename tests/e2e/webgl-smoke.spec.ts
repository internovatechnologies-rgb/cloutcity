import { expect, test } from './fixtures/test'

// Proves the e2e browser can run the 3D scene at all: headless Chromium must create a WebGL2
// context (via the SwiftShader launch flags in playwright.config.ts) and actually render with it.
// The console guard also proves the opt-in produced no SwiftShader deprecation warning.

test('headless Chromium creates a working WebGL2 context', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 4
    canvas.height = 4
    const gl = canvas.getContext('webgl2')
    if (!gl) return null

    gl.clearColor(1, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const pixel = new Uint8Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      isWebGL2: gl instanceof WebGL2RenderingContext,
      version: String(gl.getParameter(gl.VERSION)),
      renderer: debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : '',
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      pixel: Array.from(pixel),
    }
  })

  expect(result, 'getContext("webgl2") returned null').not.toBeNull()
  expect(result?.isWebGL2).toBe(true)
  expect(result?.version).toMatch(/^WebGL 2\.0/)
  expect(result?.maxTextureSize).toBeGreaterThanOrEqual(2048)
  expect(result?.pixel, 'clear colour read back from the framebuffer').toEqual([255, 0, 0, 255])
  test.info().annotations.push({ type: 'webgl-renderer', description: result?.renderer ?? '' })
})
