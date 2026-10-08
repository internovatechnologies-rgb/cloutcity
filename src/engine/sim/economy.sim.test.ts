/**
 * S12 economy simulation: the bot (economyBot.ts) plays 30 game days on each entry job with the
 * shipped balance.json, and the result must hit the CLAUDE.md target feel. The full result is
 * also the committed baseline data/sim/economy-baseline.derived.json (S18c's plausibility
 * ceilings), so any change to the economy fails here until the baseline is regenerated.
 *
 * S13 adds clout: the job bots earn only the first paycheck's clout, and a flex bot (a
 * barista, flexing once a day at the Queens ballpark) shows how fast flexing reaches Local.
 * The baseline's clout maxima come from all of these runs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { balance } from '@/lib/data/config'
import { landmarks, venues } from '@/lib/data/content'
import { cloutCeilings, cloutLevel, findCloutLevel } from '../clout'
import { engineConfig, type EngineConfig, type HomeId, type JobId } from '../config'
import { initialSnapshot } from '../game'
import { grantCeilings } from '../grants'
import { jobIds, jobLock, shiftWage } from '../jobs'
import type { Place } from '../places'
import { homeIds, rentFor } from '../rent'
import { runEconomyBot, type BotReport } from './economyBot'
import { maxCloutPlaces } from './maxCloutPlaces'

const DAYS = 30
/** Whole dollars: the target's band for the best job, and a sanity envelope for every job. */
const BEST_FINAL_CASH = { min: 800, max: 1250 }
const BEST_WEEKLY_SAVINGS = { min: 115, max: 185 }
const ANY_WEEKLY_SAVINGS = { min: 80, max: 230 }
const BASELINE = '../../../data/sim/economy-baseline.derived.json'
const DRIFT_HINT =
  'The economy changed. Re-run `npm run econ:update`, check the target block still passes, ' +
  'and log the change in progress.md Tuning log.'

// toMatchFileSnapshot would quietly write a missing baseline (no CI=true here), so a deleted
// fixture would pass: refuse to run without it.
if (!existsSync(new URL(BASELINE, import.meta.url))) {
  throw new Error(`${BASELINE} is missing: run \`npm run econ:update\` and commit it`)
}

const config = engineConfig
const { target } = balance
const start = initialSnapshot(config)
const entryJobs = jobIds(config).filter((id) => jobLock(start.player, id, config) === null)

/** The first apartment upgrade: the lowest-rent home above the starting one. */
function firstUpgrade(): HomeId {
  const startRent = rentFor(config.startHome, config)
  const [upgrade] = homeIds(config)
    .filter((id) => rentFor(id, config) > startRent)
    .sort((a, b) => rentFor(a, config) - rentFor(b, config))
  if (upgrade === undefined) throw new Error('rentPerWeek has no home above the start home')
  return upgrade
}

const upgradeTo = firstUpgrade()
const runAll = (engine: EngineConfig) =>
  entryJobs.map((jobId) => runEconomyBot({ jobId, days: DAYS, upgradeTo }, engine))
const bestOf = (all: readonly BotReport[]) =>
  all.reduce((a, b) => (b.finalCash > a.finalCash ? b : a))
const reports = runAll(config)
const best = bestOf(reports)
const byJob = reports.map((report) => [report.jobId, report] as const)

/**
 * The flex bot: a barista (the entry job with the lightest shifts, so energy is left after the
 * second one) flexing at the Queens ballpark, in the starting borough (x1.25).
 */
const FLEX_PLACE_ID = 'queens-ballpark'
const flexPlace: Place = (() => {
  const found = landmarks.find((landmark) => landmark.id === FLEX_PLACE_ID)
  if (found === undefined) throw new Error(`no landmark ${FLEX_PLACE_ID}`)
  return found
})()
const runFlex = (engine: EngineConfig, jobId: JobId = 'barista') =>
  runEconomyBot({ jobId, days: DAYS, upgradeTo, flex: { place: flexPlace } }, engine)
const flexReport = runFlex(config)

/**
 * The max-clout bot (S18c): a barista playing for clout as hard as an honest player can,
 * flexing at the best-multiplier places first and taking the best club that lets it in.
 */
const runMaxClout = (engine: EngineConfig, jobId: JobId = 'barista') =>
  runEconomyBot(
    { jobId, days: DAYS, upgradeTo, maxClout: maxCloutPlaces([...landmarks, ...venues], engine) },
    engine,
  )
const maxCloutReport = runMaxClout(config)

/**
 * Every job a player can hold, with both routines (S18c honest pace): a job behind a clout level
 * is taken when the player reaches it, working barista until then.
 */
const maxCloutOption = (engine: EngineConfig) => maxCloutPlaces([...landmarks, ...venues], engine)
/** The routines each job is played with for the honest pace (every job, at its real gate). */
const PACE_ROUTINES = ['plain', 'max-clout', 'lean', 'lean max-clout'] as const
const paceReports = (engine: EngineConfig) =>
  jobIds(engine).flatMap((jobId) => [
    runEconomyBot({ jobId, days: DAYS, upgradeTo }, engine),
    runMaxClout(engine, jobId),
    // Skip meals: shift and sleep only, the fewest taps per dollar (S18c H-1).
    runEconomyBot({ jobId, days: DAYS, upgradeTo, lean: true }, engine),
    runEconomyBot(
      { jobId, days: DAYS, upgradeTo, lean: true, maxClout: maxCloutOption(engine) },
      engine,
    ),
  ])
const allJobPaceReports = paceReports(config)

/** A per-tap average, rounded up to a hundredth so the baseline stays readable. */
const perTap = (value: number) => Math.ceil(value * 100) / 100

/** The baseline file: money from the job bots, clout maxima from those and the flex bot. */
function baseline(
  all: readonly BotReport[],
  flexRuns: readonly BotReport[] = [flexReport],
  paceRuns: readonly BotReport[] = allJobPaceReports,
) {
  const max = (pick: (report: BotReport) => number) => Math.max(...all.map(pick))
  const cloutRuns = [...all, ...flexRuns]
  const cloutMax = (pick: (report: BotReport) => number) => Math.max(...cloutRuns.map(pick))
  // The best of each run's whole-run pace and the best week it kept up.
  const paceMax = (pick: (report: BotReport) => number) =>
    Math.max(...[...cloutRuns, ...paceRuns].map(pick))
  const sources: Record<string, number> = {}
  for (const report of cloutRuns) {
    for (const [kind, gain] of Object.entries(report.cloutGainBySource)) {
      sources[kind] = Math.max(sources[kind] ?? 0, gain)
    }
  }
  return {
    version: 1,
    generatedBy: 'src/engine/sim/economy.sim.test.ts',
    days: DAYS,
    bestJob: bestOf(all).jobId,
    jobs: Object.fromEntries(
      all.map((report) => [
        report.jobId,
        {
          finalCash: report.finalCash,
          minCash: report.minCash,
          weeklySavings: report.weeklySavings,
          firstAffordableDay: report.firstAffordableDay,
        },
      ]),
    ),
    cash: {
      maxGainPerAction: max((report) => report.maxCashGainPerAction),
      maxGainPerGameDay: max((report) => report.maxCashGainPerGameDay),
      maxGainPerGameHour: max((report) => report.maxCashGainPerGameHour),
    },
    clout: {
      maxGainPerAction: cloutMax((report) => report.maxCloutGainPerAction),
      maxGainPerGameDay: cloutMax((report) => report.maxCloutGainPerGameDay),
      sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))),
    },
    actions: { maxPerGameDay: max((report) => report.maxActionsPerGameDay) },
    // Honest pace (S18c, DEC-19): what a tap earns, over a whole run or the best week of it, at
    // the best of every bot: every job a player can hold, plain and max-clout.
    pace: {
      cashPerTap: perTap(
        paceMax((report) =>
          Math.max(report.cashGained / Math.max(1, report.taps), report.weekPace.cashPerTap),
        ),
      ),
      cloutPerTap: perTap(
        paceMax((report) =>
          Math.max(report.cloutGained / Math.max(1, report.taps), report.weekPace.cloutPerTap),
        ),
      ),
    },
  }
}

describe('economy simulation: 30 game days solo', () => {
  it('plays every entry job, and only entry jobs, toward the first upgrade', () => {
    expect(entryJobs).toEqual(['barista', 'retail', 'delivery'])
    expect(upgradeTo).toBe('brooklyn-1br')
  })

  it.each(byJob)('%s never goes broke, misses rent or misses a shift', (_, report) => {
    expect(report.minCash).toBeGreaterThanOrEqual(0)
    expect(report.missedOrEvicted).toBe(0)
    expect(report.shiftsWorked).toBe(DAYS * target.shiftsPerDay)
    expect(report.shiftsMissed).toBe(0)
  })

  it.each(byJob)('%s saves a sane amount every week', (_, report) => {
    expect(report.weeklySavings).toHaveLength(3)
    for (const saved of report.weeklySavings) {
      expect(saved).toBeGreaterThanOrEqual(ANY_WEEKLY_SAVINGS.min)
      expect(saved).toBeLessThanOrEqual(ANY_WEEKLY_SAVINGS.max)
    }
  })

  it('the best job ends neither broke nor wildly rich', () => {
    expect(best.finalCash).toBeGreaterThanOrEqual(BEST_FINAL_CASH.min)
    expect(best.finalCash).toBeLessThanOrEqual(BEST_FINAL_CASH.max)
  })

  it('the best job saves roughly the target each week', () => {
    for (const saved of best.weeklySavings) {
      expect(saved).toBeGreaterThanOrEqual(BEST_WEEKLY_SAVINGS.min)
      expect(saved).toBeLessThanOrEqual(BEST_WEEKLY_SAVINGS.max)
    }
    expect(BEST_WEEKLY_SAVINGS.min).toBeLessThan(target.weeklySavings)
    expect(BEST_WEEKLY_SAVINGS.max).toBeGreaterThan(target.weeklySavings)
  })

  it('the best job can afford the first upgrade within the target days', () => {
    const { min, max } = target.firstUpgradeGameDay
    expect(best.firstAffordableDay).not.toBeNull()
    expect(best.firstAffordableDay).toBeGreaterThanOrEqual(min)
    expect(best.firstAffordableDay).toBeLessThanOrEqual(max)
  })

  it('matches the committed baseline (the balance has not drifted)', async () => {
    expect(existsSync(new URL(BASELINE, import.meta.url)), `${BASELINE} is missing`).toBe(true)
    const json = `${JSON.stringify(baseline(reports), null, 2)}\n`
    await expect(json).toMatchFileSnapshot(BASELINE, DRIFT_HINT)
  })
})

/** Every target and envelope check above, as labels of the ones a set of runs breaks. */
function targetViolations(all: readonly BotReport[]): string[] {
  const broken = new Set<string>()
  const within = (n: number, band: { min: number; max: number }) => n >= band.min && n <= band.max
  for (const report of all) {
    if (report.minCash < 0) broken.add('went broke')
    if (report.missedOrEvicted > 0) broken.add('missed rent')
    if (report.shiftsMissed > 0 || report.shiftsWorked !== DAYS * target.shiftsPerDay) {
      broken.add('missed a shift')
    }
    const sane = report.weeklySavings.every((saved) => within(saved, ANY_WEEKLY_SAVINGS))
    if (report.weeklySavings.length !== 3 || !sane) broken.add('envelope')
  }
  const top = bestOf(all)
  if (!within(top.finalCash, BEST_FINAL_CASH)) broken.add('final cash')
  if (!top.weeklySavings.every((saved) => within(saved, BEST_WEEKLY_SAVINGS))) {
    broken.add('weekly savings')
  }
  const day = top.firstAffordableDay
  if (day === null || !within(day, target.firstUpgradeGameDay)) broken.add('upgrade day')
  return [...broken]
}

const withCatalog = (actionId: string, patch: object): EngineConfig => {
  const def = config.actions.catalog[actionId]
  if (def === undefined) throw new Error(`no ${actionId} in the catalog`)
  const catalog = { ...config.actions.catalog, [actionId]: { ...def, ...patch } }
  return { ...config, actions: { ...config.actions, catalog } }
}
const withFare = (subwayFare: number): EngineConfig => ({
  ...config,
  costs: { ...config.costs, subwayFare },
})
const committedBaseline = readFileSync(new URL(BASELINE, import.meta.url), 'utf8')
const baselineJson = (all: readonly BotReport[]) => `${JSON.stringify(baseline(all), null, 2)}\n`

describe('economy simulation: the test catches drift', () => {
  it('the shipped balance breaks no target (the helper agrees with the tests above)', () => {
    expect(targetViolations(reports)).toEqual([])
  })

  const sleepEffects = config.actions.catalog.sleep?.statEffects ?? {}
  it.each<[string, EngineConfig, string[]]>([
    [
      'deli coffee at $8',
      withCatalog('deli-coffee', { cashCost: 8 }),
      ['weekly savings', 'upgrade day'],
    ],
    [
      'sleep restoring 70 energy',
      withCatalog('sleep', { statEffects: { ...sleepEffects, energy: 70 } }),
      ['weekly savings', 'upgrade day'],
    ],
    [
      'the start home at $320 a week',
      { ...config, rentPerWeek: { ...config.rentPerWeek, [config.startHome]: 320 } },
      ['final cash', 'weekly savings'],
    ],
    ['$300 start cash', { ...config, startCash: 300 }, ['upgrade day']],
  ])('%s breaks the target layer', (_label, tuned, expected) => {
    const broken = targetViolations(runAll(tuned))
    for (const label of expected) expect(broken).toContain(label)
  })

  it('a $3 to $5 fare change is caught by the fixture layer (and the target)', () => {
    const all = runAll(withFare(5))
    expect(baselineJson(reports)).toBe(committedBaseline)
    expect(baselineJson(all)).not.toBe(committedBaseline)
    expect(targetViolations(all)).toContain('final cash')
  })

  it('a $1 fare rise passes every target band, so only the fixture layer catches it', () => {
    const all = runAll(withFare(config.costs.subwayFare + 1))
    expect(targetViolations(all)).toEqual([])
    expect(baselineJson(all)).not.toBe(committedBaseline)
  })
})

describe('economy simulation: how much the result leans on mood hitting 0', () => {
  // The bot ignores mood, so on the shipped balance mood reaches 0 and every action (shifts and
  // sleep included) takes 1.25x as long. Holding mood up (no mood decay; mood at 0 has no extra
  // decay, so this is the same as a 1x multiplier) gave, on the S12 tuning:
  //   (numbers are produced by the run below; see data/sim/economy-baseline.derived.json for the shipped ones)
  // The target still holds, so the tuning does not depend on mood hitting 0.
  const moodHeld: EngineConfig = {
    ...config,
    stats: { ...config.stats, decayPerGameHour: { ...config.stats.decayPerGameHour, mood: 0 } },
  }
  const held = runAll(moodHeld)

  it('mood at 0 does change the result (the dependency is real)', () => {
    expect(held.map((report) => report.finalCash)).not.toEqual(
      reports.map((report) => report.finalCash),
    )
  })

  it('with mood held above 0 every target and envelope still holds', () => {
    expect(targetViolations(held)).toEqual([])
  })
})

describe('economy baseline fixture (read by S18c)', () => {
  const file = JSON.parse(committedBaseline) as ReturnType<typeof baseline>
  const topWage = Math.max(...entryJobs.map((id) => shiftWage(id, config)))

  it('is stable two-space JSON with a trailing newline, as econ:update writes it', () => {
    expect(committedBaseline).toBe(`${JSON.stringify(file, null, 2)}\n`)
  })

  it('covers exactly the entry jobs over the simulated days, best job included', () => {
    expect(Object.keys(file.jobs)).toEqual(entryJobs)
    expect(file.days).toBe(DAYS)
    expect(file.bestJob).toBe(best.jobId)
  })

  it('its cash maxima are the top entry wage: per shift, per day of shifts and per hour', () => {
    expect(file.cash.maxGainPerAction).toBe(topWage)
    expect(file.cash.maxGainPerGameDay).toBe(target.shiftsPerDay * topWage)
    const topHourly = Math.max(...entryJobs.map((id) => config.jobs.hourlyWage[id]))
    expect(file.cash.maxGainPerGameHour).toBe(topHourly)
    expect(file.actions.maxPerGameDay).toBe(Math.max(...reports.map((r) => r.maxActionsPerGameDay)))
  })

  it("matches the bots' clout maxima; the paycheck source is the configured first paycheck", () => {
    const runs = [...reports, flexReport]
    expect(file.clout.maxGainPerAction).toBe(Math.max(...runs.map((r) => r.maxCloutGainPerAction)))
    expect(file.clout.maxGainPerGameDay).toBe(
      Math.max(...runs.map((r) => r.maxCloutGainPerGameDay)),
    )
    // The bots wear nothing, so the first paycheck lands unscaled.
    expect(file.clout.sources.paycheck).toBe(config.clout.sources.firstPaycheck)
    expect(Object.keys(file.clout.sources).sort()).toEqual(['flex', 'paycheck'])
  })

  it('every clout value is within the theoretical ceilings S18c falls back on', () => {
    const ceilings = cloutCeilings(config)
    const perAction = Object.values(ceilings.bySource).map((ceiling) => ceiling?.perAction ?? 0)
    const perDay = Object.values(ceilings.bySource).map((ceiling) => ceiling?.perGameDay ?? 0)
    expect(file.clout.maxGainPerAction).toBeLessThanOrEqual(Math.max(...perAction))
    expect(file.clout.maxGainPerGameDay).toBeLessThanOrEqual(perDay.reduce((a, b) => a + b, 0))
    for (const [source, gain] of Object.entries(file.clout.sources)) {
      const ceiling = ceilings.bySource[source as keyof typeof ceilings.bySource]
      expect(ceiling, source).toBeDefined()
      expect(gain, source).toBeLessThanOrEqual(ceiling?.perAction ?? 0)
    }
  })
})

describe('economy simulation: clout', () => {
  const local = findCloutLevel('local', config)
  const juniorDev = findCloutLevel(config.jobs.requiredCloutLevel['junior-dev'] ?? '', config)

  it.each(byJob)(
    '%s without flexing ends at Nobody with only the first paycheck, junior dev still locked',
    (_, report) => {
      expect(report.finalClout).toBe(config.clout.sources.firstPaycheck)
      expect(cloutLevel(report.finalClout, config).id).toBe('nobody')
      expect(Object.keys(report.levelReachedDay)).toEqual(['nobody'])
      expect(juniorDev).toBeDefined()
      expect(cloutLevel(report.finalClout, config).index).toBeLessThan(juniorDev?.index ?? 0)
      expect(report.cloutGainBySource).toEqual({ paycheck: config.clout.sources.firstPaycheck })
    },
  )

  it('the flex bot never goes broke or misses rent, and reaches Local between day 8 and 20', () => {
    expect(flexReport.minCash).toBeGreaterThanOrEqual(0)
    expect(flexReport.missedOrEvicted).toBe(0)
    expect(flexReport.shiftsMissed).toBe(0)
    expect(flexReport.flexes).toBeGreaterThan(0)
    expect(local).toBeDefined()
    const day = flexReport.levelReachedDay.local
    expect(day).toBeGreaterThanOrEqual(8)
    expect(day).toBeLessThanOrEqual(20)
  })

  it('the max-clout bot stays solvent and out-earns the flex bot in clout per tap', () => {
    expect(maxCloutReport.minCash).toBeGreaterThanOrEqual(0)
    expect(maxCloutReport.missedOrEvicted).toBe(0)
    expect(maxCloutReport.flexes).toBeGreaterThan(flexReport.flexes)
    expect(maxCloutReport.flexes).toBeLessThanOrEqual(DAYS * config.clout.flex.maxPerGameDay)
    const perTap = (report: BotReport) => report.cloutGained / report.taps
    expect(perTap(maxCloutReport)).toBeGreaterThan(perTap(flexReport))
  })

  it('the honest pace covers every job with every routine, junior dev from when it unlocks', () => {
    expect(allJobPaceReports.map((report) => report.jobId)).toEqual(
      jobIds(config).flatMap((id) => PACE_ROUTINES.map(() => id)),
    )
    for (const report of allJobPaceReports) {
      expect(report.minCash, report.jobId).toBeGreaterThanOrEqual(0)
      expect(report.missedOrEvicted, report.jobId).toBe(0)
    }
    const { pace } = baseline(reports)
    for (const report of allJobPaceReports) {
      expect(pace.cashPerTap).toBeGreaterThanOrEqual(report.weekPace.cashPerTap)
      expect(pace.cloutPerTap).toBeGreaterThanOrEqual(report.weekPace.cloutPerTap)
      expect(pace.cloutPerTap).toBeGreaterThanOrEqual(report.cloutGained / report.taps)
    }
    // The max-clout junior dev reaches Local and takes the job.
    const juniorMax = allJobPaceReports.find(
      (report, i) =>
        report.jobId === 'junior-dev' && PACE_ROUTINES[i % PACE_ROUTINES.length] === 'max-clout',
    )
    expect(juniorMax?.levelReachedDay.local).toBeDefined()
  })

  it('the flex bot flexes once a day, as the place rules allow', () => {
    expect(flexReport.flexes).toBeLessThanOrEqual(DAYS)
    expect(flexReport.flexes).toBeGreaterThanOrEqual(DAYS - 2)
    expect(flexReport.viralFlexes).toBeLessThanOrEqual(flexReport.flexes)
  })
})

describe('economy simulation: the bot copes with every tuned key moved by one', () => {
  // S12 tuned these keys; a nudge of 1 either way must never make the routine fall off its
  // schedule (crash on the day guard) or lose track of a shift.
  const TUNED: readonly (readonly string[])[] = [
    ['stats', 'decayPerGameHour', 'energy'],
    ['stats', 'decayPerGameHour', 'hunger'],
    ['actions', 'catalog', 'home-meal', 'cashCost'],
    ['actions', 'catalog', 'bodega-breakfast', 'cashCost'],
    ['actions', 'catalog', 'deli-coffee', 'cashCost'],
    ['actions', 'catalog', 'deli-coffee', 'statEffects', 'energy'],
    ['actions', 'catalog', 'sleep', 'statEffects', 'energy'],
    ['actions', 'catalog', 'nap', 'statEffects', 'energy'],
    ['jobs', 'energyCostPerShift', 'retail'],
    ['jobs', 'energyCostPerShift', 'delivery'],
    ['housing', 'moveInCost', 'brooklyn-1br'],
  ]

  /** A copy of the shipped config with the number at `path` moved by `delta`. */
  function nudged(path: readonly string[], delta: number): EngineConfig {
    const copy = structuredClone(config) as unknown as Record<string, unknown>
    let node = copy
    for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>
    const leaf = path.at(-1) ?? ''
    const value = node[leaf]
    if (typeof value !== 'number') throw new Error(`${path.join('.')} is not a number`)
    node[leaf] = value + delta
    return copy as unknown as EngineConfig
  }

  const cases = TUNED.flatMap((path) =>
    [-1, 1].map((delta) => [`${path.join('.')} ${delta > 0 ? '+1' : '-1'}`, path, delta] as const),
  )

  it.each(cases)('%s: every entry job plays every day', (_label, path, delta) => {
    const tuned = nudged(path, delta)
    for (const jobId of entryJobs) {
      const report = runEconomyBot({ jobId, days: DAYS, upgradeTo }, tuned)
      expect(report.cashByDay, jobId).toHaveLength(DAYS)
      expect(report.shiftsWorked + report.shiftsMissed, jobId).toBe(DAYS * target.shiftsPerDay)
      expect(report.minCash, jobId).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('economy simulation: claiming every goal reward (S15, ECON-1)', () => {
  const claimAll = (jobId: JobId, flex?: { readonly place: Place }) =>
    runEconomyBot(
      { jobId, days: DAYS, upgradeTo, claimAll: true, ...(flex ? { flex } : {}) },
      config,
    )
  const claimed = [
    ...entryJobs.map((jobId) => claimAll(jobId)),
    claimAll('barista', { place: flexPlace }),
  ]
  const byRun = claimed.map(
    (report, i) => [i === entryJobs.length ? 'flex' : report.jobId, report] as const,
  )

  it.each(byRun)('%s: rewards are claimed, and only within their caps', (_, report) => {
    expect(report.grants.count).toBeGreaterThan(0)
    expect(report.goalsReachedDay['first-paycheck']).toBe(1)
    const ceilings = grantCeilings(config)
    expect(report.grants.cash).toBeLessThanOrEqual(ceilings.perRun.cash)
    expect(report.grants.clout).toBeLessThanOrEqual(ceilings.perRun.clout)
  })

  it.each(byRun)('%s: never goes broke or rich, and misses no rent', (_, report) => {
    expect(report.minCash).toBeGreaterThanOrEqual(0)
    expect(report.missedOrEvicted).toBe(0)
    expect(report.finalCash).toBeLessThanOrEqual(BEST_FINAL_CASH.max)
  })

  it.each(byRun)('%s: the first upgrade never comes before the target window', (_, report) => {
    expect(report.firstAffordableDay).not.toBeNull()
    expect(report.firstAffordableDay).toBeGreaterThanOrEqual(target.firstUpgradeGameDay.min)
  })

  it('granted clout never moves goal progress: levels are reached on the same days', () => {
    const flexClaim = byRun.at(-1)?.[1]
    expect(flexClaim?.goalsReachedDay['reach-local']).toBe(flexReport.levelReachedDay.local)
  })

  it('is off by default: the plain runs (and the committed baseline) are unchanged', () => {
    expect(reports.every((report) => report.grants.count === 0)).toBe(true)
    expect(baselineJson(reports)).toBe(committedBaseline)
  })
})
