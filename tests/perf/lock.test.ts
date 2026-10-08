import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquirePerfLock, waitForQuietMachine, type LockDeps } from './lock'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function lockDir(): string {
  const parent = mkdtempSync(join(tmpdir(), 'perf-lock-'))
  dirs.push(parent)
  return join(parent, 'lock')
}

/** A fake clock that advances only when the code sleeps. */
function deps(overrides: Partial<LockDeps> = {}) {
  let now = 0
  const sleeps: number[] = []
  const value: LockDeps = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
    alive: () => true,
    pid: 1000,
    cwd: '/repo/lane-e',
    ...overrides,
  }
  return { deps: value, sleeps }
}

const OPTIONS = { waitMaxMs: 3000, pollMs: 1000 }

function holdLock(dir: string, owner: unknown) {
  mkdirSync(dir)
  writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner))
}

describe('acquirePerfLock', () => {
  it('takes a free lock, records its owner and releases it', async () => {
    const dir = lockDir()
    const release = await acquirePerfLock({ ...OPTIONS, dir }, deps().deps)
    expect(JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8'))).toEqual({
      pid: 1000,
      cwd: '/repo/lane-e',
      startedAt: 0,
    })
    release()
    expect(existsSync(dir)).toBe(false)
  })

  it('waits for a live owner and fails after waitMaxMs, naming it', async () => {
    const dir = lockDir()
    holdLock(dir, { pid: 2000, cwd: '/repo/lane-a', startedAt: 0 })
    const { deps: fake, sleeps } = deps()
    await expect(acquirePerfLock({ ...OPTIONS, dir }, fake)).rejects.toThrow(
      /still held by pid 2000 in \/repo\/lane-a after 3000 ms/,
    )
    expect(sleeps).toEqual([1000, 1000, 1000])
    expect(existsSync(dir)).toBe(true)
  })

  it('takes the lock once the other run releases it', async () => {
    const dir = lockDir()
    holdLock(dir, { pid: 2000, cwd: '/repo/lane-a', startedAt: 0 })
    const fake = deps().deps
    const release = await acquirePerfLock(
      { ...OPTIONS, dir },
      {
        ...fake,
        sleep: async (ms) => {
          await fake.sleep(ms)
          rmSync(dir, { recursive: true, force: true })
        },
      },
    )
    expect(JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')).pid).toBe(1000)
    release()
  })

  it('reclaims a lock whose owner has exited', async () => {
    const dir = lockDir()
    holdLock(dir, { pid: 2000, cwd: '/repo/lane-a', startedAt: 0 })
    const { deps: fake, sleeps } = deps({ alive: (pid) => pid !== 2000 })
    await acquirePerfLock({ ...OPTIONS, dir }, fake)
    expect(sleeps).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')).pid).toBe(1000)
  })

  it('never reclaims a lock with an unreadable owner (it may be mid-creation)', async () => {
    const dir = lockDir()
    mkdirSync(dir)
    const { deps: fake } = deps({ alive: () => false })
    await expect(acquirePerfLock({ ...OPTIONS, dir }, fake)).rejects.toThrow(/an unknown run/)
    expect(existsSync(dir)).toBe(true)
  })

  it('a release after losing the lock leaves the new owner alone', async () => {
    const dir = lockDir()
    const release = await acquirePerfLock({ ...OPTIONS, dir }, deps().deps)
    rmSync(dir, { recursive: true, force: true })
    holdLock(dir, { pid: 3000, cwd: '/repo/lane-b', startedAt: 5 })
    release()
    expect(existsSync(dir)).toBe(true)
  })
})

describe('waitForQuietMachine', () => {
  const options = { maxLoadPerCore: 0.75, loadWaitMaxMs: 3000, loadPollMs: 1000 }

  function loadDeps(loads: readonly number[]) {
    let now = 0
    let index = 0
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms
      },
      loadPerCore: () => loads[Math.min(index++, loads.length - 1)] ?? 0,
    }
  }

  it('returns at once on a quiet machine, including exactly at the limit', async () => {
    expect(await waitForQuietMachine(options, loadDeps([0.75]))).toEqual({
      quiet: true,
      loadPerCore: 0.75,
      waitedMs: 0,
    })
  })

  it('waits until the load drops', async () => {
    expect(await waitForQuietMachine(options, loadDeps([2, 1, 0.5]))).toEqual({
      quiet: true,
      loadPerCore: 0.5,
      waitedMs: 2000,
    })
  })

  it('gives up after loadWaitMaxMs on a busy machine', async () => {
    expect(await waitForQuietMachine(options, loadDeps([0.76]))).toEqual({
      quiet: false,
      loadPerCore: 0.76,
      waitedMs: 3000,
    })
  })
})
