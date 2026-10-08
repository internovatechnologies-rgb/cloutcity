/**
 * S18c honest-play guard (bug-hunter fix cycle 3, F3 and F4): every job a player can hold, with
 * the plain and the max-clout routine (junior dev taken when the player's level unlocks it),
 * replayed at a person's pace (4 s a tap) and uploaded at every cadence from every step to every
 * 40 steps, is accepted in full. A public level behind the save's is a display delay, never a
 * refusal.
 */
import { describe, expect, it } from 'vitest'
import baselineJson from '@data/sim/economy-baseline.derived.json'
import { sync } from '@/lib/data/config'
import { landmarks, venues } from '@/lib/data/content'
import { EconomyBaselineSchema } from '@/lib/data/schemas/sim'
import { realMsPerGameMinute } from './clock'
import { findCloutLevel, playerLevel } from './clout'
import { engineConfig as config, type JobId } from './config'
import { jobIds } from './jobs'
import { initialEventsState } from './events'
import { syncGoals } from './goals'
import {
  checkUpload,
  plausibilityCeilings,
  type CashClout,
  type UploadContext,
  type Verdict,
} from './plausibility'
import { initialSave, type SaveState } from './save'
import { runEconomyBot, type BotStep } from './sim/economyBot'
import { maxCloutPlaces } from './sim/maxCloutPlaces'
import { playerWithClout } from './test-support'

const baseline = EconomyBaselineSchema.parse(baselineJson)
const ceilings = plausibilityCeilings(config, baseline, sync)
const TAP_MS = 4000

const ctx = (patch: Partial<UploadContext> = {}): UploadContext => ({
  realMinutesSinceAccept: 1,
  burstCreditMinutes: sync.plausibility.burstRealMinutes,
  accountAgeMinutes: 24 * 60,
  serverGrantKeys: [],
  entitledItemIds: [],
  firstUpload: false,
  ...patch,
})

function asSave(step: BotStep, actions: number): SaveState {
  return {
    ...step.snapshot,
    speed: 1,
    events: initialEventsState(),
    goals: step.goals,
    grants: step.grants,
    prestige: step.prestige,
    actions,
  }
}

interface Played {
  readonly save: SaveState
  readonly realMs: number
}

/**
 * Bot play: on the shipped config (a locked job is taken when the level unlocks it), or with
 * `unlockJob` every job open from day 1, a stress case stricter than real play. The checks always
 * use the shipped config.
 */
function play(
  jobId: JobId,
  opts: { maxClout?: boolean; unlockJob?: boolean; lean?: boolean } = {},
): Played[] {
  const simConfig =
    opts.unlockJob === true
      ? { ...config, jobs: { ...config.jobs, requiredCloutLevel: {} } }
      : config
  const steps: Played[] = []
  let minute = initialSave(config).clock.minute
  let taps = 0
  let claims = 0
  runEconomyBot(
    {
      jobId,
      days: 30,
      upgradeTo: 'brooklyn-1br',
      claimAll: true,
      ...(opts.lean === true ? { lean: true } : {}),
      ...(opts.maxClout === true
        ? { maxClout: maxCloutPlaces([...landmarks, ...venues], config) }
        : {}),
      onStep: (step) => {
        const moved = step.snapshot.clock.minute - minute
        minute = step.snapshot.clock.minute
        if (step.counted) taps += 1
        taps += step.grants.log.length - claims
        claims = step.grants.log.length
        steps.push({
          save: asSave(step, taps),
          realMs: step.counted ? TAP_MS : moved * realMsPerGameMinute(config),
        })
      },
    },
    simConfig,
  )
  return steps
}

function replay(steps: readonly Played[], every: number) {
  let prev: SaveState | null = null
  const server = new Set<string>()
  let sinceAccept = 0
  let credit = 0
  let pace: CashClout | null = null
  let age = 0
  const verdicts: { verdict: Verdict; upload: SaveState; pace: CashClout | null }[] = []
  const upload = (save: SaveState, first: boolean) => {
    const verdict = checkUpload(
      prev,
      save,
      ctx({
        realMinutesSinceAccept: sinceAccept / 60_000,
        burstCreditMinutes: credit,
        paceCredit: pace,
        accountAgeMinutes: age / 60_000,
        serverGrantKeys: [...server],
        firstUpload: first,
      }),
      ceilings,
      config,
    )
    verdicts.push({ verdict, upload: save, pace })
    if (verdict.save !== null) {
      prev = verdict.save
      sinceAccept = 0
      credit = verdict.burstCreditMinutes ?? credit
      pace = verdict.paceCredit ?? pace
      for (const record of verdict.grantsToInsert) server.add(record.key)
    }
  }
  upload(initialSave(config), true)
  steps.forEach((step, i) => {
    sinceAccept += step.realMs
    age += step.realMs
    if ((i + 1) % every === 0 || i === steps.length - 1) upload(step.save, false)
  })
  return verdicts
}

const firstReject = (verdicts: ReturnType<typeof replay>) => {
  const bad = verdicts.find((v) => v.verdict.outcome === 'reject')
  return bad === undefined
    ? null
    : `day ${Math.floor(bad.upload.clock.minute / 1440) + 1}: ${bad.verdict.findings.join(',')} (credit before ${JSON.stringify(bad.pace)})`
}

const CADENCES = [1, 2, 3, 5, 8, 15, 40] as const
/** Every routine the honest pace covers, the lean ones (skip meals: shift and sleep) included. */
const ROUTINES = [
  ['plain', { maxClout: false, lean: false }],
  ['max-clout', { maxClout: true, lean: false }],
  ['lean', { maxClout: false, lean: true }],
  ['lean max-clout', { maxClout: true, lean: true }],
] as const
const runs = jobIds(config).flatMap((jobId) =>
  ROUTINES.map(([routine, opts]) => ({ jobId, routine, steps: play(jobId, opts) })),
)

describe('honest play at every cadence is never refused (F3, F4)', () => {
  it.each(CADENCES)(
    'every job, every routine (lean included), uploading every %i steps',
    (every) => {
      const label = (run: (typeof runs)[number]) => `${run.jobId} ${run.routine}`
      const rejects = Object.fromEntries(
        runs.map((run) => [label(run), firstReject(replay(run.steps, every))]),
      )
      expect(rejects).toEqual(Object.fromEntries(runs.map((run) => [label(run), null])))
    },
  )

  it('the max-clout junior dev is accepted throughout; its public level only ever lags', () => {
    const run = runs.find((entry) => entry.jobId === 'junior-dev' && entry.routine === 'max-clout')
    if (run === undefined) throw new Error('no junior-dev max-clout run')
    const verdicts = replay(run.steps, 1)
    for (const { verdict, upload } of verdicts) {
      expect(verdict.outcome).not.toBe('reject')
      const level = playerLevel(upload.player, config).index
      const shown = verdict.publicView?.level_index ?? -1
      expect(shown).toBeLessThanOrEqual(level)
      // A lag is the age cap at work, a display delay: never a finding that refuses anything.
      if (shown < level) expect(verdict.findings).toEqual(['public-level-capped'])
    }
  })

  it('stress: junior dev open from day 1 (stricter than real play), both routines', () => {
    for (const maxClout of [false, true]) {
      const steps = play('junior-dev', { maxClout, unlockJob: true })
      for (const every of [1, 15]) {
        expect(
          firstReject(replay(steps, every)),
          `max-clout ${maxClout}, every ${every}`,
        ).toBeNull()
      }
    }
  })
})

describe('the public level cap (H1)', () => {
  it('a forged Icon on a young account (first upload) is not public Icon', () => {
    const icon = findCloutLevel('icon', config)
    if (icon === undefined) throw new Error('no icon')
    const base = initialSave(config)
    const forged = syncGoals(
      {
        ...base,
        clock: { minute: 200 * 1440, remainderMs: 0 },
        player: playerWithClout(base.player, icon.minClout * 3, config),
      },
      config,
    ).save
    for (const minutes of [2, 30, 59]) {
      const v = checkUpload(
        null,
        forged,
        ctx({ firstUpload: true, accountAgeMinutes: minutes }),
        ceilings,
        config,
      )
      expect(v.publicView?.level_id, `${minutes} min`).not.toBe('icon')
      expect(playerLevel(forged.player, config).id).toBe('icon')
    }
  })
})
