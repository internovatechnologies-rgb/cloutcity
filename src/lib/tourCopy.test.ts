/**
 * The tour's copy and data/config/tour.json (S06): the target exists, each step fits the banner
 * zone, and the whole tour reads in about the acceptance's 20 seconds.
 */
import { describe, expect, it } from 'vitest'
import tourJson from '@data/config/tour.json'
import { engineConfig } from '@/engine/config'
import { initialSnapshot } from '@/engine/game'
import { TourConfigSchema } from '@/lib/data/schemas/config'
import { TOUR_STEPS, type ActiveTour, type TourStep } from '@/state/tour'
import { createCopy } from './copy'
import { baseCopy, slangPacks } from './copy/all'
import { tourNames, tourStepText } from './tourCopy'

const config = TourConfigSchema.parse(tourJson)
const target = { placeId: config.placeId, actionId: config.actionId }
const snapshot = initialSnapshot(engineConfig)
const action = engineConfig.actions.catalog[config.actionId]

const NO_PACK = { id: 'base', strings: {} }

/** The widest receipt a guided purchase can show: from the most cash to the least. */
const WIDEST = { before: 9_999_999, after: 9_999_999 }

function texts(packId: string | null) {
  const copy = createCopy(baseCopy, (packId === null ? undefined : slangPacks[packId]) ?? NO_PACK)
  const names = tourNames(target, snapshot, { copy })
  return TOUR_STEPS.map((step: TourStep) => {
    const record: ActiveTour = {
      status: 'active',
      step,
      receipt: step === 'cash' ? WIDEST : null,
    }
    return { step, text: tourStepText(record, names, { copy }) }
  })
}

describe('the tour (S06)', () => {
  it('leads to an action the place really has, with a cash cost', () => {
    expect(action, `balance.json has no action ${config.actionId}`).toBeDefined()
    expect(action?.cashCost).toBeGreaterThan(0)
    expect(tourNames(target, snapshot)).toEqual({
      place: 'Late Lantern Deli',
      action: 'Breakfast sandwich',
    })
  })

  it('a new player can afford it at the start', () => {
    expect(engineConfig.startCash).toBeGreaterThanOrEqual(action?.cashCost ?? Infinity)
  })

  it(`has at most maxSteps steps`, () => {
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(config.maxSteps)
  })

  for (const pack of [null, ...Object.keys(slangPacks)]) {
    it(`every step fits ${config.maxCharsPerStep} characters (${pack ?? 'base'})`, () => {
      for (const { step, text } of texts(pack)) {
        expect(text.length, `${step}: "${text}"`).toBeLessThanOrEqual(config.maxCharsPerStep)
        expect(text.length, step).toBeGreaterThan(0)
      }
    })

    it(`reads in about ${config.timing.targetSeconds} s (${pack ?? 'base'})`, () => {
      const chars = texts(pack).reduce((sum, { text }) => sum + text.length, 0)
      const seconds =
        chars / config.timing.readCharsPerSecond + TOUR_STEPS.length * config.timing.secondsPerTap
      expect(seconds).toBeLessThanOrEqual(config.timing.targetSeconds)
    })
  }

  it('the cash step shows the purchase with the shared money formatter', () => {
    const copy = createCopy(baseCopy, NO_PACK)
    const text = tourStepText(
      { status: 'active', step: 'cash', receipt: { before: 150, after: 140 } },
      tourNames(target, snapshot, { copy }),
      { copy },
    )
    expect(text).toBe('Paid. Your cash went from $150 to $140.')
  })
})

describe('the purchase step away from the place (S08)', () => {
  for (const pack of [null, ...Object.keys(slangPacks)]) {
    const copy = createCopy(baseCopy, (pack === null ? undefined : slangPacks[pack]) ?? NO_PACK)
    const names = tourNames(target, snapshot, { copy })
    const away = tourStepText({ status: 'active', step: 'buy', receipt: null }, names, {
      copy,
      here: false,
    })

    it(`names the "Walk there" button by its own label and fits (${pack ?? 'base'})`, () => {
      expect(away).toContain(copy('travel.mode.walk.action'))
      expect(away).toContain(names.action)
      expect(away.length).toBeLessThanOrEqual(config.maxCharsPerStep)
    })

    it(`the walking tour, one tap longer, still reads in about ${config.timing.targetSeconds} s (${pack ?? 'base'})`, () => {
      const chars = texts(pack).reduce(
        (sum, { step, text }) => sum + (step === 'buy' ? away.length : text.length),
        0,
      )
      const seconds =
        chars / config.timing.readCharsPerSecond +
        (TOUR_STEPS.length + 1) * config.timing.secondsPerTap
      expect(seconds).toBeLessThanOrEqual(config.timing.targetSeconds)
    })
  }
})
