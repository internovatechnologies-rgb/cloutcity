import { expect, test } from './fixtures/test'
import { SILENT, audio, installAudioProbe, probeOf, trackAudioRequests } from './fixtures/audio'
import { storedOnboarding } from './fixtures/welcome'
import { waitForMapSettled } from './helpers/scene'
import { openFromHud } from './helpers/hud'

// A returning player (the shared fixture seeds a completed card with "I'll bring my own") hears
// nothing until they tap the sound control; their choice is remembered (S05b, GR-13).

test('stays silent until the sound control is tapped, and remembers "My own music"', async ({
  page,
}) => {
  await installAudioProbe(page)
  const requests = trackAudioRequests(page)
  await page.goto('/')
  await waitForMapSettled(page)

  const control = page.getByRole('button', { name: 'Turn on sound' })
  await expect(control).toBeVisible()
  await expect(control).toContainText('Tap for sound')
  await expect(control).toHaveAccessibleDescription('Your music')
  expect(await probeOf(page)).toEqual(SILENT)

  // Taps anywhere else are gestures too, but never the deliberate one.
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('viewport size is not set')
  await page.mouse.click(viewport.width / 2, viewport.height / 2)
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Map', exact: true })
    .click()
  await page.locator('[data-hud-cell="money"]').click()
  await page.keyboard.press('Space')
  expect(await probeOf(page)).toEqual(SILENT)
  expect(requests).toEqual([])

  await control.click()
  await expect.poll(() => probeOf(page).then((p) => p.contexts)).toBe(1)
  await expect.poll(() => audio.ready(page)).toBe(true)
  expect(await audio.contextState(page)).toBe('running')
  expect((await audio.targetGains(page)).music).toBe(0)
  const toggle = page.getByRole('button', { name: 'My own music' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await openFromHud(page, 'Settings')
  await expect(
    page.getByRole('region', { name: 'Settings' }).getByRole('checkbox', { name: 'My own music' }),
  ).toBeChecked()

  await page.reload()
  await waitForMapSettled(page)
  await expect(page.getByRole('button', { name: 'Turn on sound' })).toHaveAccessibleDescription(
    'Your music',
  )
  expect((await probeOf(page)).contexts).toBe(0)
  expect(await storedOnboarding(page)).toMatchObject({ state: { record: { audioChoice: 'own' } } })
})
