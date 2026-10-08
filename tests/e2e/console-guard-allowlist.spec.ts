import { test } from './fixtures/test'

// The SwiftShader ReadPixels note is ignored only at warning level (orchestrator ruling, S01).

const NOTE =
  '[.WebGL-0x11c0043de00]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels'

test('the allowlisted note still fails the test when logged as an error (PERF-1)', async ({
  page,
}) => {
  test.fail()
  await page.goto('/')
  await page.evaluate((text) => {
    // eslint-disable-next-line no-console -- deliberately provoking the guard
    console.error(text)
  }, NOTE)
})

// Playwright's blocked-registration stand-in (S04e) is ignored only as that exact warning.
test('the blocked service worker warning still fails the test when logged as an error', async ({
  page,
}) => {
  test.fail()
  await page.goto('/')
  await page.evaluate(() => {
    // eslint-disable-next-line no-console -- deliberately provoking the guard
    console.error('Service Worker registration blocked by Playwright')
  })
})
