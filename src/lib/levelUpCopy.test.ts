import { describe, expect, it } from 'vitest'
import { recordClout, type LevelUp } from '@/engine/clout'
import { engineConfig } from '@/engine/config'
import { initialSnapshot } from '@/engine/game'
import { withClout } from '@/engine/test-support'
import { createCopy } from './copy'
import { baseCopy, slangPacks } from './copy/all'
import { boroughs } from './world/places'
import { levelUpCloseLabel, levelUpMessage, levelUpTitle, levelUpUnlocked } from './levelUpCopy'

const plain = { copy: createCopy(baseCopy, { id: 'none', strings: {} }) }
const nyc = { copy: createCopy(baseCopy, slangPacks.nyc ?? { id: 'none', strings: {} }) }

function levelUpTo(total: number): LevelUp {
  const change = { source: 'event', amount: total, ref: { eventId: 'e', choiceId: 'c' } } as const
  const { levelUp } = recordClout(initialSnapshot(engineConfig), change, engineConfig)
  if (levelUp === null) throw new Error('expected a level-up')
  return levelUp
}

describe('level-up copy', () => {
  it('Local: the title, the CLAUDE.md voice line and what it unlocked', () => {
    const local = levelUpTo(100)
    expect(levelUpTitle(local, plain)).toBe('New level: Local')
    expect(levelUpMessage(local, nyc)).toBe("Your name's starting to ring. Brooklyn noticed.")
    expect(levelUpUnlocked(local, plain)).toBe('Unlocked: Brooklyn, Junior dev, Glowmatic')
    expect(levelUpCloseLabel(local, plain)).toBe('Close the Local message')
  })

  it('every level above Nobody has a message in every pack', () => {
    for (const level of engineConfig.clout.levels.slice(1)) {
      const levelUp = levelUpTo(level.minClout)
      expect(levelUp.to).toBe(level.id)
      expect(levelUpMessage(levelUp, plain)).not.toBe('')
      expect(levelUpMessage(levelUp, nyc)).not.toBe('')
    }
  })

  it('a level that unlocks nothing has no unlocked line', () => {
    const icon = { ...levelUpTo(100), unlocks: { boroughs: [], jobs: [], clubs: [] } }
    expect(levelUpUnlocked(icon, plain)).toBeNull()
  })

  it('a message that names a borough only does so at the level that unlocks it (GR-11)', () => {
    const levels = engineConfig.clout.levels
    levels.slice(1).forEach((level, i) => {
      const below = withClout(initialSnapshot(engineConfig), levels[i]?.minClout ?? 0, engineConfig)
      const change = {
        source: 'event',
        amount: level.minClout - (levels[i]?.minClout ?? 0),
        ref: { eventId: 'e', choiceId: 'c' },
      } as const
      const { levelUp } = recordClout(below, change, engineConfig)
      if (levelUp === null) throw new Error(`no level-up to ${level.id}`)
      expect(levelUp.to).toBe(level.id)
      for (const pack of [plain, nyc]) {
        const message = levelUpMessage(levelUp, pack)
        for (const borough of boroughs) {
          const name = pack.copy(borough.nameKey as Parameters<typeof pack.copy>[0])
          if (message.includes(name))
            expect(levelUp.unlocks.boroughs, `${level.id}: ${message}`).toContain(borough.id)
        }
      }
    })
  })
})
