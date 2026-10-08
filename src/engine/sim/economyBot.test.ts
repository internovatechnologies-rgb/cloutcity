/**
 * The economy bot itself (economyBot.ts): it must report every day it plays, play the same way
 * every time, and degrade (not hang or silently skip days) on a config it cannot win on.
 * economy.sim.test.ts checks its numbers against the target.
 */
import { describe, expect, it } from 'vitest'
import { engineConfig, type EngineConfig } from '../config'
import { runEconomyBot, type BotReport } from './economyBot'

const config = engineConfig
const DAYS = 30
const ENTRY_JOBS = ['barista', 'retail', 'delivery'] as const
const run = (jobId: (typeof ENTRY_JOBS)[number], engine: EngineConfig = config, days = DAYS) =>
  runEconomyBot({ jobId, days, upgradeTo: 'brooklyn-1br' }, engine)

function withCatalog(actionId: string, patch: object, engine: EngineConfig = config) {
  const def = engine.actions.catalog[actionId]
  if (def === undefined) throw new Error(`no ${actionId} in the catalog`)
  const catalog = { ...engine.actions.catalog, [actionId]: { ...def, ...patch } }
  return { ...engine, actions: { ...engine.actions, catalog } }
}

describe('economy bot: a full, honest run', () => {
  it.each(ENTRY_JOBS)('%s reports every day and pays rent on each rent day', (jobId) => {
    const report = run(jobId)
    expect(report.cashByDay).toHaveLength(DAYS)
    expect(report.rentEvents.map((event) => [event.kind, event.day])).toEqual([
      ['paid', 8],
      ['paid', 15],
      ['paid', 22],
      ['paid', 29],
    ])
    expect(report.cashByDay.at(-1)).toBe(report.finalCash)
    expect(Math.min(...report.cashByDay)).toBeGreaterThanOrEqual(report.minCash)
  })

  it('plays the same run every time, in any time zone', () => {
    const original = process.env.TZ
    const runs: BotReport[] = []
    try {
      for (const zone of ['UTC', 'Pacific/Kiritimati', 'America/New_York']) {
        process.env.TZ = zone
        runs.push(run('retail'))
      }
    } finally {
      process.env.TZ = original
    }
    expect(runs[1]).toEqual(runs[0])
    expect(runs[2]).toEqual(runs[0])
  })
})

describe('economy bot: configs it cannot win on', () => {
  it.each(ENTRY_JOBS)(
    '%s on no money and unaffordable coffee degrades: it finishes and reports the damage',
    (jobId) => {
      const starved = { ...withCatalog('deli-coffee', { cashCost: 500 }), startCash: 0 }
      const report = run(jobId, starved)
      expect(report.cashByDay).toHaveLength(DAYS)
      expect(report.minCash).toBeGreaterThanOrEqual(0)
      expect(report.firstAffordableDay).toBeNull()
      expect(report.shiftsWorked + report.shiftsMissed).toBe(DAYS * 2)
      expect(report.shiftsMissed + report.missedOrEvicted).toBeGreaterThan(0)
    },
  )

  it('coffee that restores nothing cannot trap the bot in a buying loop (fuel guard)', () => {
    // Plenty of cash, so only the per-shift fuel cap (20 coffees) stops the buying.
    const useless = { ...withCatalog('deli-coffee', { statEffects: {} }), startCash: 100_000 }
    const report = run('barista', useless)
    expect(report.cashByDay).toHaveLength(DAYS)
    expect(report.maxActionsPerGameDay).toBeLessThanOrEqual(2 * 20 + 10)
  })

  // Orchestrator ruling (S12 fix cycle 1): a late day now skips its work instead of throwing, so a
  // 21 h 40 m sleep no longer overruns. The guard still fires when an action can't fit at all: a
  // sleep longer than maxDurationMin is refused by the engine and the next routine starts a day early.
  it('a routine that overruns a whole day fails loudly instead of skipping the day', () => {
    const endlessSleep = withCatalog('sleep', { durationMin: config.actions.maxDurationMin + 10 })
    expect(() => run('retail', endlessSleep, 3)).toThrow(/day \d+'s routine started on day \d+/)
  })
})

describe('economy bot: a slightly kinder balance still plays out', () => {
  // Each nudge below only helps the player (more rest, less hunger), so a sensible routine must
  // still work every shift and pay every rent. A failure here is the bot's routine falling off
  // its schedule, not the economy: see the S12 bug-hunter report.
  const sleepEffects = config.actions.catalog.sleep?.statEffects ?? {}
  const decay = config.stats.decayPerGameHour
  it.each<[string, EngineConfig]>([
    ['nap +1 energy', withCatalog('nap', { statEffects: { energy: 5 } })],
    ['sleep +1 energy', withCatalog('sleep', { statEffects: { ...sleepEffects, energy: 56 } })],
    ['deli coffee +1 energy', withCatalog('deli-coffee', { statEffects: { energy: 21 } })],
    [
      'hunger decay -1 an hour',
      { ...config, stats: { ...config.stats, decayPerGameHour: { ...decay, hunger: 5 } } },
    ],
  ])('%s: every entry job works every shift and pays every rent', (_label, kinder) => {
    for (const jobId of ENTRY_JOBS) {
      const report = run(jobId, kinder)
      expect(report.shiftsMissed, jobId).toBe(0)
      expect(report.missedOrEvicted, jobId).toBe(0)
    }
  })
})
