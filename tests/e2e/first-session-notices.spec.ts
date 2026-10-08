import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { passWelcomeCard } from './fixtures/welcome'
import { waitForMapSettled } from './helpers/scene'
import {
  buyThroughPlaces,
  expectStep,
  tourCard,
  tourConfig,
  tourDone,
  tourNext,
} from './helpers/tour'

// S06, GR-9: a brand-new player starts with at most `newPlayerNoticeMax` notices, each a
// meaningful kind. A MutationObserver installed before the app loads records every element
// tagged `data-cc-notice` that ever appears (src/lib/notices.test.ts makes sure every notice
// surface carries the tag), through the welcome card, the tour and its purchase.

test.use({ onboarding: 'fresh', tour: 'fresh' })

declare global {
  interface Window {
    __ccNotices?: string[]
  }
}

async function recordNotices(page: Page) {
  await page.addInitScript(() => {
    const seen = new WeakSet<Element>()
    const kinds: string[] = []
    window.__ccNotices = kinds
    const visit = (node: Node) => {
      if (!(node instanceof Element)) return
      const tagged = [
        ...(node.matches('[data-cc-notice]') ? [node] : []),
        ...node.querySelectorAll('[data-cc-notice]'),
      ]
      for (const element of tagged) {
        if (seen.has(element)) continue
        seen.add(element)
        kinds.push(element.getAttribute('data-cc-notice') ?? '')
      }
    }
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') visit(record.target)
        for (const node of record.addedNodes) visit(node)
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-cc-notice'],
    })
  })
}

const notices = (page: Page) => page.evaluate(() => [...(window.__ccNotices ?? [])])

test('a new player sees at most three notices, each meaningful', async ({ page }) => {
  await recordNotices(page)
  await page.goto('/')
  await passWelcomeCard(page)
  await waitForMapSettled(page)
  await expectStep(page, 'hud')
  // The first thing a new player sees past the card is the tour, and only the tour.
  expect(await notices(page)).toEqual(['tour'])

  await tourNext(page).click()
  await buyThroughPlaces(page)
  await tourNext(page).click()
  await tourDone(page).click()
  await expect(tourCard(page)).toHaveCount(0)

  const seen = await notices(page)
  expect(seen.length).toBeLessThanOrEqual(tourConfig.newPlayerNoticeMax)
  for (const kind of seen) expect(tourConfig.meaningfulNotices).toContain(kind)
  // Nothing on screen asks for attention once the tour is done: no badge, toast or dialog.
  await expect(page.locator('[data-cc-notice]')).toHaveCount(0)
})
