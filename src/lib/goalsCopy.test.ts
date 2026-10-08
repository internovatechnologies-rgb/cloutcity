/** S15 copy: every goal, badge and prestige part has its strings, and amounts match the engine. */
import { describe, expect, it } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { goalsView, syncGoals, type GoalView } from '@/engine/goals'
import { initialSave } from '@/engine/save'
import { playerWithClout } from '@/engine/test-support'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { createCopy, findLiteralSuperlatives } from '@/lib/copy'
import { PRESTIGE_PARTS } from '@/lib/data/goalFacts'
import {
  badgeName,
  claimButton,
  goalHint,
  goalName,
  goalProgressLabel,
  prestigePartName,
  rewardLine,
  rewardText,
} from './goalsCopy'

const nyc = createCopy(baseCopy, slangPacks.nyc ?? { id: 'nyc', strings: {} })
const plain = createCopy(baseCopy, slangPacks.plain ?? { id: 'plain', strings: {} })

function views(clout: number): readonly GoalView[] {
  const base = initialSave(config)
  const save = syncGoals(
    { ...base, player: playerWithClout(base.player, clout, config) },
    config,
  ).save
  return goalsView(save, config)
}
const view = (clout: number, id: string) => {
  const found = views(clout).find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no goal ${id}`)
  return found
}

describe('goals copy (S15)', () => {
  it('every goal id has a name and a hint, in every pack', () => {
    for (const goal of config.goals) {
      for (const copy of [nyc, plain]) {
        expect(goalName(goal.id, { copy }).length, goal.id).toBeGreaterThan(0)
        expect(goalHint(goal.id, { copy }).length, goal.id).toBeGreaterThan(0)
      }
    }
  })

  it('every prestige badge and part has a name', () => {
    for (const badge of config.prestige.badgeIds) expect(badgeName(badge)).toMatch(/^Prestige /)
    for (const part of PRESTIGE_PARTS) expect(prestigePartName(part).length).toBeGreaterThan(0)
  })

  it('says the first friend is coming soon', () => {
    expect(goalHint('first-friend')).toBe('Friends unlock soon.')
  })

  it('has no literal superlatives and no braces outside placeholders', () => {
    // Every S15 string, in the base copy and in every slang pack that overrides it.
    const s15 = (key: string) =>
      /^(goals\.|share\.icon\.|loading\.(goals|iconMoment)$|hud\.goals)/.test(key)
    for (const strings of [baseCopy.strings, ...Object.values(slangPacks).map((p) => p.strings)]) {
      const goals = Object.fromEntries(Object.entries(strings).filter(([key]) => s15(key)))
      expect(findLiteralSuperlatives(goals)).toEqual([])
      for (const text of Object.values(goals)) {
        expect(text.replace(/\{[a-zA-Z]+\}/g, '')).not.toMatch(/[{}]/)
      }
    }
  })

  it('names amounts with the shared formatters', () => {
    expect(rewardText({ cash: 25, clout: 5, badge: null })).toBe('$25 and 5 clout')
    expect(rewardText({ cash: 25, clout: 0, badge: null })).toBe('$25')
    expect(rewardText({ cash: 0, clout: 5, badge: null })).toBe('5 clout')
    expect(rewardText({ cash: 0, clout: 0, badge: 'prestige-1' })).toBe('the Prestige I badge')
    expect(rewardText({ cash: 0, clout: 0, badge: null })).toBe('nothing more this time')
  })

  it('the progress bar names goal clout, the Claim button the capped amount or why not', () => {
    expect(goalProgressLabel(view(40, 'reach-local'))).toBe('Reach Local: 40 of 100 earned clout')
    expect(goalProgressLabel(view(40, 'first-outfit'))).toBe('First outfit: 0 of 1')
    expect(claimButton(view(120, 'reach-local'))).toEqual({
      text: 'Claim $50 and 15 clout',
      label: 'Claim $50 and 15 clout for Reach Local',
    })
    // 290 clout: 25% of the 10 to Scene Regular is 2 clout.
    expect(claimButton(view(290, 'reach-local')).label).toBe(
      'Claim $50 and 2 clout for Reach Local',
    )
    expect(rewardLine(view(290, 'reach-local'))).toBe('Reward: $50 and 2 clout')
    expect(claimButton(view(0, 'reach-local')).label).toBe(
      'Claim $50 and 15 clout for Reach Local: reach the goal first',
    )
  })
})
