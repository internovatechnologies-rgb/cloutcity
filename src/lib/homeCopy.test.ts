import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import type { HomeError, HomeLock } from '@/engine/home'
import { homeLock, slotsFor } from '@/engine/home'
import { isDecor } from '@/engine/items'
import { initialSnapshot } from '@/engine/game'
import { createCopy } from '@/lib/copy'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { HOME_IDS } from '@/lib/data/homes'
import {
  homeErrorText,
  homeLockName,
  homeLockReason,
  homeScoreLine,
  moveConfirmText,
  moveDetails,
  moveLabel,
  slotName,
  variantName,
} from './homeCopy'

const plain = { copy: createCopy(baseCopy, { id: 'none', strings: {} }) }
const packs = Object.values(slangPacks)
const decor = engineConfig.items.catalog.filter(isDecor)
const initialPlayer = () => initialSnapshot(engineConfig).player

describe('home copy', () => {
  it('names every slot of every home and every decor colour in words, in every pack (A11Y-1)', () => {
    for (const pack of packs) {
      const copy = createCopy(baseCopy, pack)
      for (const home of HOME_IDS) {
        for (const slot of slotsFor(home, engineConfig)) {
          expect(slotName(home, slot.id, { copy }).length).toBeGreaterThan(0)
        }
      }
      for (const item of decor) {
        for (const variant of item.decor.variants) {
          const name = variantName(item.id, variant.id, { copy })
          expect(name).not.toMatch(/#|[a-z]+-\d{2,3}/)
          expect(name.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('calls the pink fairy lights Hot pink in the nyc pack', () => {
    const nyc = slangPacks.nyc
    if (nyc === undefined) throw new Error('no nyc pack')
    expect(variantName('fairy-string-lights', 'pink', { copy: createCopy(baseCopy, nyc) })).toBe(
      'Hot pink',
    )
  })

  it('gives each move its cost, weekly rent and slot count from config', () => {
    expect(moveDetails('brooklyn-1br', plain)).toBe('Move-in $400, rent $520/wk, 5 slots')
    expect(moveLabel('brooklyn-1br', plain)).toContain('rent $520/wk, 5 slots')
    expect(moveConfirmText('brooklyn-1br', plain)).toContain('$520/wk')
  })

  it('names a locked home "{home}. {reason}", in voice in the nyc pack', () => {
    const player = initialPlayer()
    for (const home of ['brooklyn-1br', 'manhattan-loft'] as const) {
      const lock = homeLock(player, home, engineConfig)
      expect(lock?.code).toBe('BOROUGH_LOCKED')
      if (lock === null) continue
      expect(homeLockName(lock, plain)).toMatch(/^(Brooklyn 1BR|Manhattan loft)\. .+/)
    }
    const nyc = slangPacks.nyc
    if (nyc === undefined) throw new Error('no nyc pack')
    const loft = homeLock(player, 'manhattan-loft', engineConfig)
    if (loft === null) throw new Error('the loft should be locked')
    expect(homeLockReason(loft, { copy: createCopy(baseCopy, nyc) })).toContain('bodega money')
  })

  it('has player-facing text for every home error code', () => {
    const lock: HomeLock = {
      code: 'FUNDS_SHORT',
      home: 'brooklyn-1br',
      required: 680,
      available: 150,
    }
    const errors: HomeError[] = [
      { code: 'UNKNOWN_ITEM', itemId: 'nope' },
      { code: 'NOT_DECOR', itemId: 'cargo-pants' },
      { code: 'NOT_OWNED', itemId: 'fairy-string-lights' },
      { code: 'UNKNOWN_SLOT', slotId: 'wall-9' },
      {
        code: 'WRONG_SLOT_KIND',
        itemId: 'fairy-string-lights',
        slotId: 'floor-1',
        fits: 'wall',
        kind: 'floor',
      },
      { code: 'UNKNOWN_VARIANT', itemId: 'fairy-string-lights', variantId: 'plaid' },
      { code: 'UNKNOWN_HOME', home: 'penthouse' },
      { code: 'CURRENT_HOME', home: 'queens-room' },
      {
        code: 'BOROUGH_LOCKED',
        home: 'manhattan-loft',
        borough: 'manhattan',
        access: { status: 'expanding-soon' },
      },
      lock,
    ]
    for (const pack of packs) {
      const copy = createCopy(baseCopy, pack)
      const texts = errors.map((error) => homeErrorText(error, { copy }))
      for (const text of texts) {
        expect(text.length).toBeGreaterThan(0)
        expect(text).not.toMatch(/[{}]/)
      }
    }
    expect(homeErrorText(errors[4] as HomeError, plain)).toBe(
      'Fairy string lights needs a wall spot, not a floor spot.',
    )
    expect(homeErrorText(lock, plain)).toContain('$680')
  })

  it('says when the home clout cap holds the score', () => {
    const player = initialPlayer()
    expect(homeScoreLine(player, plain)).toBe('Home score 0: +0 clout')
    const capped = { ...engineConfig, home: { ...engineConfig.home, maxClout: 0 } }
    const loft = { ...player, home: 'manhattan-loft' as const }
    expect(homeScoreLine(loft, { ...plain, config: capped })).toContain('cap')
  })
})
