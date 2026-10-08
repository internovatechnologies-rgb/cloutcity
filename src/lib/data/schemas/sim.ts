/**
 * Schema for /data/sim: the economy baseline written by src/engine/sim/economy.sim.test.ts
 * (`npm run econ:update`). S18c reads its maxima as the plausibility ceilings for saves.
 */
import { z } from 'zod'
import { JOB_IDS } from './config'

const dollars = z.int()
const ceiling = z.number().nonnegative()

const JobBaselineSchema = z.strictObject({
  finalCash: dollars.nonnegative(),
  minCash: dollars.nonnegative(),
  /** Cash saved from one paid rent day to the next (weeks 2, 3 and 4 of a 30-day run). */
  weeklySavings: z.array(dollars),
  /** The first game day the next home up was affordable, or null if it never was. */
  firstAffordableDay: z.int().positive().nullable(),
})

export const EconomyBaselineSchema = z
  .strictObject({
    version: z.literal(1),
    generatedBy: z.literal('src/engine/sim/economy.sim.test.ts'),
    /** Game days each bot run plays. */
    days: z.int().positive(),
    /** The job whose run ended with the most cash. */
    bestJob: z.enum(JOB_IDS),
    jobs: z.partialRecord(z.enum(JOB_IDS), JobBaselineSchema),
    /** Maxima across every job's run. Gains are never netted against spending. */
    cash: z.strictObject({
      maxGainPerAction: ceiling,
      maxGainPerGameDay: ceiling,
      maxGainPerGameHour: ceiling,
    }),
    clout: z.strictObject({
      maxGainPerAction: ceiling,
      maxGainPerGameDay: ceiling,
      /** Largest clout gain from one step, by what the bot did. */
      sources: z.record(z.string().min(1), ceiling),
    }),
    actions: z.strictObject({ maxPerGameDay: z.int().nonnegative() }),
    /**
     * Honest pace (S18c, DEC-19): gain per tap over a whole run (gross, every bot's run; the
     * highest), the save plausibility's per-tap ceilings before the margin.
     */
    pace: z.strictObject({ cashPerTap: ceiling, cloutPerTap: ceiling }),
  })
  .refine((baseline) => baseline.bestJob in baseline.jobs, {
    error: 'bestJob must be one of jobs',
    path: ['bestJob'],
  })
export type EconomyBaseline = z.infer<typeof EconomyBaselineSchema>
