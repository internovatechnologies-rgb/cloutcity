/**
 * Global setup of `npm run e2e:perf` (playwright.perf.config.ts): takes the machine-wide perf
 * lock, then waits for a quiet machine. A run that cannot get either fails instead of measuring
 * under load. Playwright runs the returned function as the global teardown, which releases the
 * lock.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PerfConfigSchema } from '@/lib/data/schemas/config'
import { acquirePerfLock, waitForQuietMachine } from './lock'

export default async function globalSetup(): Promise<() => void> {
  const perf = PerfConfigSchema.parse(
    JSON.parse(readFileSync(join(process.cwd(), 'data/config/perf.json'), 'utf8')),
  )
  const run = perf.perfRun
  const release = await acquirePerfLock({ waitMaxMs: run.lockWaitMaxMs, pollMs: run.loadPollMs })
  try {
    const machine = await waitForQuietMachine(run)
    if (!machine.quiet) {
      throw new Error(
        `Machine still busy after ${machine.waitedMs} ms (load ${machine.loadPerCore.toFixed(2)} per core, perf.json perfRun.maxLoadPerCore ${run.maxLoadPerCore}); not measuring under load`,
      )
    }
  } catch (error) {
    release()
    throw error
  }
  return release
}
