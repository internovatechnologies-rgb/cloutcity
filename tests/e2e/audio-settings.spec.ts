import { expect, test } from './fixtures/test'
import { audio, gainOf, installAudioProbe, probeOf } from './fixtures/audio'
import { waitForMapSettled } from './helpers/scene'
import { hudOpener, openFromHud } from './helpers/hud'

// Settings sheet, sound part (S05b): loaded on demand, native controls, live changes per channel.

test('the sheet loads on demand, opening it stays silent, and each slider moves only its channel', async ({
  page,
}) => {
  await installAudioProbe(page)
  await page.goto('/')
  await waitForMapSettled(page)
  await page.waitForLoadState('networkidle')
  const scripts: string[] = []
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(request.url())
  })

  // The settings open from the More panel at every width (S05, S06).
  const opener = hudOpener(page, 'Settings')
  await openFromHud(page, 'Settings')
  const sheet = page.getByRole('region', { name: 'Settings' })
  await expect(sheet).toBeVisible()
  expect(scripts.length, 'the sheet chunk loads on the first tap').toBeGreaterThan(0)
  expect((await probeOf(page)).contexts, 'opening the sheet is not the audio choice').toBe(0)

  const master = sheet.getByRole('slider', { name: 'Master' })
  await expect(master).toHaveValue('80')
  await master.fill('40')
  await expect(sheet.locator('output[for="sound-volume-master"]')).toHaveText('40%')
  await expect.poll(() => probeOf(page).then((p) => p.contexts)).toBe(1)
  await expect.poll(() => audio.ready(page)).toBe(true)
  await expect.poll(() => audio.gains(page).then((g) => g.master)).toBe(gainOf(40))
  const afterMaster = await audio.gains(page)
  expect(afterMaster).toMatchObject({
    music: 0,
    sfx: gainOf(80),
    ambience: gainOf(40),
    voice: gainOf(80),
  })

  await sheet.getByRole('slider', { name: 'Sound effects' }).fill('20')
  await expect.poll(() => audio.gains(page).then((g) => g.sfx)).toBe(gainOf(20))
  expect({ ...(await audio.gains(page)), sfx: afterMaster.sfx }).toEqual(afterMaster)

  const ambience = sheet.getByRole('slider', { name: 'City sounds' })
  await ambience.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(ambience).toHaveValue('35')
  await expect.poll(() => audio.gains(page).then((g) => g.ambience)).toBe(gainOf(35))

  await master.fill('0')
  await expect(page.getByRole('button', { name: 'My own music' })).toHaveAccessibleDescription(
    'Sound off',
  )

  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(opener).toBeFocused()
})

// S05: the sound control sits in the HUD's actions cell beside the Places button (S04c) and the
// More button, which holds the sound settings at every width (S06).
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
  { width: 390, height: 600 },
  { width: 844, height: 390 },
] as const) {
  test(`the sound control stays inside the HUD, at least 44 px, at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await waitForMapSettled(page)
    const hud = await page.locator('[data-overlay-zone="hud"]').boundingBox()
    if (!hud) throw new Error('no HUD zone')
    const names = ['Turn on sound', 'More', 'Places']
    for (const name of names) {
      const box = await page
        .locator('[data-overlay-zone="hud"]')
        .getByRole('button', { name, exact: true })
        .boundingBox()
      if (!box) throw new Error(`${name} not rendered`)
      expect(box.width, name).toBeGreaterThanOrEqual(44)
      expect(box.height, name).toBeGreaterThanOrEqual(44)
      expect(box.y, name).toBeGreaterThanOrEqual(hud.y)
      expect(box.y + box.height, name).toBeLessThanOrEqual(hud.y + hud.height)
      expect(box.x, name).toBeGreaterThanOrEqual(hud.x)
      expect(box.x + box.width, name).toBeLessThanOrEqual(hud.x + hud.width)
    }
    // Both lines of the control are visible text at every width (UX-7).
    await expect(page.getByText('Tap for sound', { exact: true })).toBeVisible()
  })
}

test('accessible with the sheet closed and open', async ({ page, checkA11y }) => {
  await page.goto('/')
  await waitForMapSettled(page)
  await checkA11y()
  await openFromHud(page, 'Settings')
  await expect(page.getByRole('region', { name: 'Settings' })).toBeVisible()
  await checkA11y()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('region', { name: 'Settings' })).toHaveCount(0)
  await expect(hudOpener(page, 'Settings')).toBeFocused()
})

interface Box {
  x: number
  y: number
  width: number
  height: number
}
const overlaps = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)

test('the sound settings and an event can be open together without overlapping (UX-1)', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForMapSettled(page)
  await page.waitForFunction(() => window.__cloutcityTest?.events !== undefined)
  await waitForMapSettled(page)
  await openFromHud(page, 'Settings')
  const sheet = page.getByRole('region', { name: 'Settings' })
  await expect(sheet).toBeVisible()

  const opened = await page.evaluate(() =>
    window.__cloutcityTest?.events?.open('bodega-cat', {
      borough: 'queens',
      locationId: null,
      locationCategory: 'bodega',
      itemIds: [],
    }),
  )
  expect(opened?.ok).toBe(true)
  const dialog = page.getByRole('dialog', { name: 'The bodega cat chose you' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: /Pet the cat/ })).toBeFocused()

  const zone = await page.locator('[data-overlay-zone="sheet"]').boundingBox()
  const dialogBox = await dialog.boundingBox()
  if (!zone || !dialogBox) throw new Error('sheet zone or dialog not rendered')
  expect(dialogBox.y).toBeGreaterThanOrEqual(zone.y)
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(zone.y + zone.height)
  const sheetBox = await sheet.boundingBox()
  if (sheetBox) expect(overlaps(sheetBox, dialogBox), 'sound sheet overlaps the event').toBe(false)
  for (const other of ['banner', 'hud', 'toast', 'tabs']) {
    const box = await page.locator(`[data-overlay-zone="${other}"]`).boundingBox()
    if (!box) throw new Error(`${other} zone missing`)
    expect(overlaps(dialogBox, box), `event overlaps ${other}`).toBe(false)
  }

  // Escape belongs to the event (a forced choice stays open), not to the sound sheet behind it.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /Pet the cat/ }).click()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Settings' })).toBeVisible()
})

test('a long track title stays on one truncated line inside the HUD, clear of the other cells', async ({
  page,
}) => {
  await page.goto('/')
  await waitForMapSettled(page)
  await page.getByRole('button', { name: 'Turn on sound' }).click()
  const toggle = page.getByRole('button', { name: 'My own music' })
  await toggle.click()
  await expect(toggle).toHaveAccessibleDescription(/^♪ .+ by .+$/)

  const hud = await page.locator('[data-overlay-zone="hud"]').boundingBox()
  const control = await toggle.boundingBox()
  if (!hud || !control) throw new Error('HUD not rendered')
  expect(control.x + control.width).toBeLessThanOrEqual(hud.x + hud.width)
  expect(control.y + control.height).toBeLessThanOrEqual(hud.y + hud.height)
  for (const cell of ['money', 'clock', 'speed', 'clout', 'stats']) {
    const box = await page.locator(`[data-hud-cell="${cell}"]`).boundingBox()
    if (!box) throw new Error(`no ${cell} cell`)
    expect(overlaps(box, control), `sound control overlaps the ${cell} cell`).toBe(false)
  }

  // Both lines are visible at every width since S05 (UX-7), each on one truncated line.
  const nowPlaying = page.locator('#sound-control-now-playing')
  await expect(nowPlaying).toBeVisible()
  const line = await nowPlaying.evaluate((element) => {
    const style = getComputedStyle(element)
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5
    return {
      overflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      oneLine: element.getBoundingClientRect().height <= lineHeight + 1,
    }
  })
  expect(line).toEqual({ overflow: 'ellipsis', whiteSpace: 'nowrap', oneLine: true })
})

test('volumes saved by a newer build are shown and never overwritten', async ({ page }) => {
  const newer = JSON.stringify({
    state: {
      volumes: { master: 55, music: 35, sfx: 70, ambience: 25, voice: 90, crowd: 10 },
      updatedAt: 5,
      future: true,
    },
    version: 2,
  })
  await page.addInitScript((value) => {
    if (localStorage.getItem('cloutcity:audio') === null) {
      localStorage.setItem('cloutcity:audio', value)
    }
  }, newer)
  await page.goto('/')
  await waitForMapSettled(page)
  await openFromHud(page, 'Settings')
  const sheet = page.getByRole('region', { name: 'Settings' })
  await expect(sheet.getByRole('slider', { name: 'Master' })).toHaveValue('55')
  await expect(sheet.getByRole('slider', { name: 'City sounds' })).toHaveValue('25')
  await sheet.getByRole('slider', { name: 'Music' }).fill('80')
  await expect(sheet.getByRole('slider', { name: 'Music' })).toHaveValue('80')
  expect(await page.evaluate(() => localStorage.getItem('cloutcity:audio'))).toBe(newer)
})

test('a corrupt sound save falls back to the defaults without a console error', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'cloutcity:audio',
      JSON.stringify({ state: { volumes: { master: 'loud' }, updatedAt: -1 }, version: 1 }),
    )
  })
  await page.goto('/')
  await waitForMapSettled(page)
  await openFromHud(page, 'Settings')
  await expect(
    page.getByRole('region', { name: 'Settings' }).getByRole('slider', { name: 'Master' }),
  ).toHaveValue('80')
})
