/**
 * Machine-wide guards for `npm run e2e:perf` (S04b). Timings are only meaningful when nothing
 * else loads the CPU, and several checkouts (lane worktrees) share this machine, so:
 * - {@link acquirePerfLock}: one perf run at a time across every checkout, through a lock
 *   directory in the OS temp dir. `mkdir` is atomic, so two runs cannot both take it. A lock
 *   whose owner process has exited is reclaimed.
 * - {@link waitForQuietMachine}: waits until the 1-minute load average per core drops to the
 *   configured level (data/config/perf.json `perfRun`).
 * The clock, sleep and process checks are injectable for tests.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleepMs } from 'node:timers/promises'

/** Shared by every checkout of the repo on this machine. */
export const PERF_LOCK_DIR = join(tmpdir(), 'cloutcity-e2e-perf.lock')

const OWNER_FILE = 'owner.json'

interface Owner {
  readonly pid: number
  readonly cwd: string
  readonly startedAt: number
}

export interface LockDeps {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<unknown>
  /** Whether a process with this id is still running. */
  readonly alive: (pid: number) => boolean
  readonly pid: number
  readonly cwd: string
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const DEFAULT_DEPS: LockDeps = {
  now: Date.now,
  sleep: sleepMs,
  alive: processAlive,
  pid: process.pid,
  cwd: process.cwd(),
}

function readOwner(dir: string): Owner | null {
  try {
    const owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8')) as Partial<Owner>
    return typeof owner.pid === 'number' && typeof owner.cwd === 'string'
      ? { pid: owner.pid, cwd: owner.cwd, startedAt: Number(owner.startedAt) }
      : null
  } catch {
    return null
  }
}

function tryTake(dir: string, deps: LockDeps): boolean {
  try {
    mkdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  const owner: Owner = { pid: deps.pid, cwd: deps.cwd, startedAt: deps.now() }
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify(owner))
  return true
}

export interface LockOptions {
  readonly dir?: string
  readonly waitMaxMs: number
  readonly pollMs: number
}

/**
 * Takes the perf lock, waiting up to `waitMaxMs` for another run to finish. Returns the release
 * function, which removes the lock only while this process still owns it. Throws, naming the
 * owner's checkout, when the wait runs out.
 */
export async function acquirePerfLock(
  options: LockOptions,
  deps: LockDeps = DEFAULT_DEPS,
): Promise<() => void> {
  const dir = options.dir ?? PERF_LOCK_DIR
  const deadline = deps.now() + options.waitMaxMs
  for (;;) {
    if (tryTake(dir, deps)) {
      return () => {
        if (readOwner(dir)?.pid === deps.pid) rmSync(dir, { recursive: true, force: true })
      }
    }
    const owner = readOwner(dir)
    // A lock with no readable owner may be mid-creation; only a dead owner is reclaimed.
    if (owner !== null && !deps.alive(owner.pid)) {
      rmSync(dir, { recursive: true, force: true })
      continue
    }
    if (deps.now() >= deadline) {
      const holder = owner === null ? 'an unknown run' : `pid ${owner.pid} in ${owner.cwd}`
      throw new Error(
        `e2e:perf lock ${dir} still held by ${holder} after ${options.waitMaxMs} ms; measuring now would time two runs against each other`,
      )
    }
    await deps.sleep(options.pollMs)
  }
}

export interface LoadDeps {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<unknown>
  /** The 1-minute load average divided by the number of cores. */
  readonly loadPerCore: () => number
}

export interface QuietOptions {
  readonly maxLoadPerCore: number
  readonly loadWaitMaxMs: number
  readonly loadPollMs: number
}

export interface QuietResult {
  readonly quiet: boolean
  readonly loadPerCore: number
  readonly waitedMs: number
}

const DEFAULT_LOAD_DEPS: LoadDeps = {
  now: Date.now,
  sleep: sleepMs,
  loadPerCore: () => (loadavg()[0] ?? 0) / availableParallelism(),
}

/** Waits until the machine is quiet enough to measure, or the wait runs out. */
export async function waitForQuietMachine(
  options: QuietOptions,
  deps: LoadDeps = DEFAULT_LOAD_DEPS,
): Promise<QuietResult> {
  const start = deps.now()
  for (;;) {
    const loadPerCore = deps.loadPerCore()
    const waitedMs = deps.now() - start
    if (loadPerCore <= options.maxLoadPerCore) return { quiet: true, loadPerCore, waitedMs }
    if (waitedMs >= options.loadWaitMaxMs) return { quiet: false, loadPerCore, waitedMs }
    await deps.sleep(options.loadPollMs)
  }
}
