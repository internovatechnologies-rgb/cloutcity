import type { Page } from '@playwright/test'

// src/state/store.ts STORE_KEY and src/engine/save.ts SAVE_VERSION, not imported: Playwright's
// loader cannot load the store's JSON imports.
export const STORE_KEY = 'cloutcity:game'
const SAVE_VERSION = 8

/** A minute of the first game day (0–1439) for a seeded save. */
export const at = (hours: number, minutes = 0): number => hours * 60 + minutes

/** A fresh player's save whose personal game clock reads `minute`; missing fields load fresh. */
export function clockSave(minute: number): string {
  return JSON.stringify({
    state: {
      clock: { minute, remainderMs: 0 },
      player: {
        cash: 150,
        stats: { energy: 80, hunger: 50, mood: 60 },
        clout: {
          ledger: [],
          compacted: { entries: 0, bySource: {} },
          nextSeq: 1,
          peakLevel: 0,
          firstPaycheckPaid: false,
        },
        flex: { rngState: 0, byPlace: {} },
        home: 'queens-room',
        rent: { owed: 0, missed: 0 },
        inventory: { wearables: [], gifts: [], outfit: {} },
        clubNights: {},
      },
      speed: 1,
      events: { active: null, history: {}, pending: [], rngState: 0 },
    },
    version: SAVE_VERSION,
  })
}

/**
 * Seeds `clockSave(minute)` on the first load of the page only (a reload keeps what the game
 * saved, unless the spec writes another save first).
 */
export async function seedClockSave(page: Page, minute: number): Promise<void> {
  const save = clockSave(minute)
  await page.addInitScript(
    ([key, raw]) => {
      if (sessionStorage.getItem('clock-seeded') !== null) return
      sessionStorage.setItem('clock-seeded', '1')
      localStorage.setItem(key, raw)
    },
    [STORE_KEY, save] as const,
  )
}

/** The scene's day/night lighting (S04f test hook). */
export const sceneLighting = (page: Page) =>
  page.evaluate(() => window.__cloutcityTest?.scene?.lighting() ?? null)
