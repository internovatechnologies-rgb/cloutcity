import { describe, expect, it } from 'vitest'
import { engineConfig, type EngineConfig } from '@/engine/config'
import { jobIds, jobLock } from '@/engine/jobs'
import { homeIds } from '@/engine/rent'
import { initialSnapshot } from '@/engine/game'
import { createCopy, findLiteralSuperlatives } from '@/lib/copy'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import {
  cloutLevelName,
  homeName,
  homeRentComparison,
  homeRentLine,
  jobLockedLabel,
  jobName,
  nextRentDueLine,
  rentNotice,
  shiftDone,
  shiftLabel,
} from './economyCopy'

const plain = createCopy(baseCopy, slangPacks.plain ?? { id: 'plain', strings: {} })
const nyc = createCopy(baseCopy, slangPacks.nyc ?? { id: 'nyc', strings: {} })

const config: EngineConfig = {
  ...engineConfig,
  rentPerWeek: { 'queens-room': 280, 'brooklyn-1br': 520, 'manhattan-loft': 1100 },
}

describe('every job, home and clout level has copy', () => {
  it.each(jobIds(engineConfig))('job %s', (id) => {
    expect(jobName(id)).not.toBe('')
    expect(shiftLabel(id)).toContain(jobName(id))
  })
  it.each(homeIds(engineConfig))('home %s', (id) => expect(homeName(id)).not.toBe(''))
  it.each(engineConfig.clout.levels.map((level) => level.id))('clout level %s', (id) => {
    expect(cloutLevelName(id)).not.toBe('')
  })
  it('an id without copy throws instead of rendering a blank', () => {
    expect(() => cloutLevelName('mayor')).toThrow(/clout\.levels\.mayor\.name/)
  })
})

describe('job copy', () => {
  it('labels a shift with its hours and computed pay', () => {
    expect(shiftLabel('barista', { copy: plain, config })).toBe(
      'Work a Barista shift: 4 hours for $56',
    )
    expect(shiftDone(140, { copy: plain })).toBe('Shift done: $140 earned.')
  })

  it('explains why junior dev is locked, naming the job and the level it needs', () => {
    const lock = jobLock(initialSnapshot(engineConfig).player, 'junior-dev', engineConfig)
    if (lock === null) throw new Error('junior dev should be locked for a new player')
    expect(jobLockedLabel(lock, { copy: plain })).toBe(
      "Junior dev is locked: reach Local clout to unlock it. You're at Nobody.",
    )
    const voiced = jobLockedLabel(lock, { copy: nyc })
    expect(voiced).toMatch(/Junior dev/)
    expect(voiced).toMatch(/locked/)
    expect(voiced).toMatch(/Local/)
  })
})

describe('housing copy compares rents computed from data (GR-11)', () => {
  it('ranks only the home whose rent the data proves lowest', () => {
    expect(homeRentLine('queens-room', { copy: plain, config })).toBe(
      'Queens room: $280 a week, the cheapest rent in the city',
    )
    expect(homeRentLine('brooklyn-1br', { copy: plain, config })).toBe('Brooklyn 1BR: $520 a week')
    expect(homeRentLine('manhattan-loft', { copy: plain, config })).toBe(
      'Manhattan loft: $1,100 a week',
    )
  })

  it('moves the rank when the rents change', () => {
    const cheapBrooklyn = {
      ...config,
      rentPerWeek: { 'queens-room': 400, 'brooklyn-1br': 250, 'manhattan-loft': 1100 },
    }
    expect(homeRentLine('queens-room', { copy: plain, config: cheapBrooklyn })).toBe(
      'Queens room: $400 a week',
    )
    expect(homeRentLine('brooklyn-1br', { copy: plain, config: cheapBrooklyn })).toMatch(/cheapest/)
  })

  it('claims no rank on a tie', () => {
    const tie = {
      ...config,
      rentPerWeek: { 'queens-room': 280, 'brooklyn-1br': 280, 'manhattan-loft': 1100 },
    }
    expect(homeRentLine('queens-room', { copy: plain, config: tie })).toBe(
      'Queens room: $280 a week',
    )
  })

  it('states the computed difference between two homes', () => {
    expect(homeRentComparison('manhattan-loft', 'queens-room', { copy: plain, config })).toBe(
      'Manhattan loft costs $820 a week more than Queens room.',
    )
    expect(homeRentComparison('queens-room', 'brooklyn-1br', { copy: plain, config })).toBe(
      'Queens room costs $240 a week less than Brooklyn 1BR.',
    )
    expect(homeRentComparison('queens-room', 'queens-room', { copy: plain, config })).toBe(
      'Queens room costs the same as Queens room.',
    )
  })

  it('the new copy holds no literal superlatives', () => {
    expect(findLiteralSuperlatives(baseCopy.strings)).toEqual([])
    for (const pack of Object.values(slangPacks)) {
      expect(findLiteralSuperlatives(pack.strings)).toEqual([])
    }
  })
})

describe('rent notices', () => {
  it('renders each kind of rent event', () => {
    const opts = { copy: plain, config }
    expect(
      rentNotice({ kind: 'paid', day: 8, home: 'queens-room', rent: 280, arrears: 0 }, opts),
    ).toBe('Rent paid: $280.')
    expect(
      rentNotice({ kind: 'paid', day: 15, home: 'queens-room', rent: 280, arrears: 310 }, opts),
    ).toBe('Rent paid: $280, plus $310 in back rent and fees.')
    expect(rentNotice({ kind: 'arrears-paid', day: 9, amount: 280 }, opts)).toBe(
      "Back rent paid: $280. You're all caught up.",
    )
    const missed = {
      kind: 'missed',
      day: 8,
      home: 'queens-room',
      rent: 280,
      lateFee: 0,
      owed: 280,
      missed: 1,
      missesBeforeEviction: 2,
    } as const
    expect(rentNotice(missed, opts)).toBe(
      "Rent missed. You owe $280, collected at midnight once you have it. Miss 2 more and you're evicted.",
    )
    expect(
      rentNotice({ ...missed, lateFee: 30, owed: 590, missed: 2, missesBeforeEviction: 1 }, opts),
    ).toBe("Rent missed again, plus a $30 late fee. You owe $590. Miss 1 more and you're evicted.")
    expect(
      rentNotice(
        { kind: 'evicted', day: 22, from: 'manhattan-loft', to: 'queens-room', forgiven: 3330 },
        opts,
      ),
    ).toBe('You were evicted for unpaid rent and moved to the Queens room, at $280 a week.')
  })

  it('the nyc pack carries the rent-due voice', () => {
    const missed = {
      kind: 'missed',
      day: 8,
      home: 'queens-room',
      rent: 280,
      lateFee: 0,
      owed: 280,
      missed: 1,
      missesBeforeEviction: 2,
    } as const
    expect(rentNotice(missed, { copy: nyc, config })).toMatch(
      /^Landlord said 'rent' and your wallet said 'not today\.'/,
    )
  })

  it('shows the next due day and rent', () => {
    expect(nextRentDueLine('brooklyn-1br', 8, { copy: plain, config })).toBe(
      'Rent of $520 is due on day 8.',
    )
  })
})

describe('economy copy edges', () => {
  const tied: EngineConfig = {
    ...engineConfig,
    rentPerWeek: { 'queens-room': 280, 'brooklyn-1br': 280, 'manhattan-loft': 1100 },
  }

  it('on a tie for the lowest rent no line and no eviction notice claims a rank', () => {
    const evicted = rentNotice(
      { kind: 'evicted', day: 22, from: 'manhattan-loft', to: 'queens-room', forgiven: 3330 },
      { copy: plain, config: tied },
    )
    const lines = [
      ...homeIds(tied).map((id) => homeRentLine(id, { copy: plain, config: tied })),
      ...homeIds(tied).map((id) => homeRentLine(id, { copy: nyc, config: tied })),
      evicted,
    ]
    for (const line of lines) expect(line).not.toMatch(/cheapest/i)
    expect(homeRentComparison('queens-room', 'brooklyn-1br', { copy: plain, config: tied })).toBe(
      'Queens room costs the same as Brooklyn 1BR.',
    )
  })

  it('the rent comparison follows the config, never a literal', () => {
    const moved: EngineConfig = {
      ...engineConfig,
      rentPerWeek: { 'queens-room': 300, 'brooklyn-1br': 250, 'manhattan-loft': 1100 },
    }
    expect(homeRentComparison('queens-room', 'brooklyn-1br', { copy: plain, config: moved })).toBe(
      'Queens room costs $50 a week more than Brooklyn 1BR.',
    )
    expect(homeRentLine('brooklyn-1br', { copy: plain, config: moved })).toMatch(/cheapest/)
    expect(homeRentLine('queens-room', { copy: plain, config: moved })).not.toMatch(/cheapest/)
  })

  it('the locked label names the current level, whichever it is', () => {
    const lock = {
      jobId: 'junior-dev',
      requiredLevel: 'known',
      currentLevel: 'scene-regular',
    } as const
    expect(jobLockedLabel(lock, { copy: plain })).toBe(
      "Junior dev is locked: reach Known clout to unlock it. You're at Scene Regular.",
    )
    expect(jobLockedLabel(lock, { copy: nyc })).toMatch(
      /Scene Regular[\s\S]*Known|Known[\s\S]*Scene Regular/,
    )
  })

  it('every pack key added for S11 exists in base copy', () => {
    for (const pack of Object.values(slangPacks)) {
      for (const key of Object.keys(pack.strings)) {
        expect(Object.hasOwn(baseCopy.strings, key), `${pack.id}: ${key}`).toBe(true)
      }
    }
  })

  it('pack strings keep the same placeholders as base', () => {
    const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    const base = baseCopy.strings as Record<string, string>
    for (const pack of Object.values(slangPacks)) {
      for (const [key, text] of Object.entries(pack.strings as Record<string, string>)) {
        if (!/^(jobs|housing|rent|clout)\./.test(key)) continue
        expect(vars(text), `${pack.id}: ${key}`).toEqual(vars(base[key] ?? ''))
      }
    }
  })
})
