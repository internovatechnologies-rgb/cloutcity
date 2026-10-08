/**
 * "Icon is earned" (S15 fix cycle 1): every level reads total clout except Icon, the victory
 * goal's level, which also needs goal clout (earned minus granted, plus items, never premium) at
 * its threshold. So the Icon level-up and the Icon moment land on the same action, and no grant
 * or premium clout can reach Icon.
 */
import { describe, expect, it } from 'vitest'
import {
  appendClout,
  cloutProgress,
  earnedOnlyLevel,
  goalClout,
  levelClout,
  playerLevel,
  recordClout,
  totalClout,
  type CloutState,
} from './clout'
import { engineConfig as config } from './config'
import { syncGoals } from './goals'
import { initialSave, loadSave, type SaveState } from './save'
import { playerWithClout } from './test-support'

const NOW = 9000
const ICON = config.clout.levels.at(-1)?.minClout ?? Number.NaN
const PREMIUM_CAP = config.clout.caps.byCurrency.usd

function add(clout: CloutState, source: 'grant' | 'premium', amount: number): CloutState {
  const ref =
    source === 'grant'
      ? { grantKey: 'goal:reach-famous:r1' }
      : { itemId: 'premium-probe', op: 'grant' as const }
  return appendClout(
    clout,
    { source, amount, ref } as Parameters<typeof appendClout>[1],
    NOW,
    config,
  ).state
}

/** A save holding `earned` clout, plus `granted` grant clout and `premium` premium clout. */
function save(earned: number, granted = 0, premium = 0): SaveState {
  const base = initialSave(config)
  let player = playerWithClout(base.player, earned, config)
  let clout = player.clout
  if (granted > 0) clout = add(clout, 'grant', granted)
  if (premium > 0) clout = add(clout, 'premium', premium)
  player = { ...player, clout }
  return { ...base, clock: { minute: NOW, remainderMs: 0 }, player }
}

describe('Icon is earned', () => {
  it('Icon is the victory goal level, the top of the ladder', () => {
    expect(earnedOnlyLevel(config)).toMatchObject({ id: 'icon', minClout: ICON })
  })

  it('4,890 earned + 110 granted: total holds Icon, the level is Famous, no Icon moment', () => {
    const s = save(4890, 110)
    expect(totalClout(s.player, config)).toBe(5000)
    expect(goalClout(s.player, config)).toBe(4890)
    expect(playerLevel(s.player, config).id).toBe('famous')
    expect(levelClout(s.player, config)).toBe(ICON - 1)
    const synced = syncGoals(s, config)
    expect(synced.iconReached).toBe(false)
    expect(synced.save.goals.achieved['reach-icon']).toBeUndefined()
    // The meter counts earned clout toward Icon, so the bar is not full.
    expect(cloutProgress(s.player, config)).toMatchObject({
      total: 5000,
      counted: 4890,
      level: { id: 'famous' },
      next: { id: 'icon' },
      atMax: false,
    })
    expect(cloutProgress(s.player, config).pct).toBeLessThan(100)
  })

  it('earning the last 110 lands the Icon level-up and the Icon moment on the same action', () => {
    const s = save(4890, 110)
    const record = recordClout(
      s,
      { source: 'event', amount: 110, ref: { eventId: 'e', choiceId: 'c' } },
      config,
    )
    expect(record.levelUp).toMatchObject({ fromPeak: 'famous', to: 'icon' })
    const after = { ...s, player: record.player }
    expect(playerLevel(after.player, config).id).toBe('icon')
    const synced = syncGoals(after, config)
    expect(synced.iconReached).toBe(true)
    expect(synced.save.goals.icon).toEqual({ reachedAt: NOW, acknowledged: false })
  })

  it('a grant that pushes the total past Icon reports no level-up', () => {
    const s = save(4890)
    const pushed = recordClout(
      s,
      { source: 'grant', amount: 200, ref: { grantKey: 'goal:probe:r1' } },
      config,
    )
    expect(totalClout(pushed.player, config)).toBe(5090)
    expect(pushed.levelUp).toBeNull()
    expect(playerLevel(pushed.player, config).id).toBe('famous')
  })

  it('premium at the cap plus earned just below Icon is not Icon', () => {
    const s = save(ICON - 1, 0, PREMIUM_CAP)
    expect(totalClout(s.player, config)).toBe(ICON - 1 + PREMIUM_CAP)
    expect(playerLevel(s.player, config).id).toBe('famous')
    expect(syncGoals(s, config).iconReached).toBe(false)
    // Premium alone (no earned clout) never gets near it either.
    expect(playerLevel(save(0, 0, PREMIUM_CAP * 10).player, config).index).toBeLessThan(
      earnedOnlyLevel(config)?.index ?? 0,
    )
  })

  it('every lower level still reads the total, grants and premium included', () => {
    expect(playerLevel(save(90, 10).player, config).id).toBe('local')
    expect(playerLevel(save(50, 0, 50).player, config).id).toBe('local')
    expect(playerLevel(save(1999, 1).player, config).id).toBe('famous')
  })
})

describe('Icon is earned: saves', () => {
  it('a save whose peak is Icon without the earned clout drops its peak to Famous on load', () => {
    const s = save(4890, 110)
    const raw = JSON.parse(
      JSON.stringify({ ...s, player: { ...s.player, clout: { ...s.player.clout, peakLevel: 5 } } }),
    ) as unknown
    const result = loadSave(raw, config)
    if (!result.ok) throw new Error('unusable')
    expect(result.repaired).toEqual(['player.clout.peakLevel'])
    expect(result.save.player.clout.peakLevel).toBe(4)
    // No level-up replays below Icon; earning it later is a real level-up.
    const record = recordClout(
      result.save,
      { source: 'event', amount: 110, ref: { eventId: 'e', choiceId: 'c' } },
      config,
    )
    expect(record.levelUp?.to).toBe('icon')
  })

  it('a peak at Icon with the earned clout for it is left alone', () => {
    const s = save(ICON)
    expect(s.player.clout.peakLevel).toBe(5)
    const result = loadSave(JSON.parse(JSON.stringify(s)) as unknown, config)
    expect(result.ok && result.repaired).toEqual([])
  })
})
