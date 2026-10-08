import { describe, expect, it } from 'vitest'
import { engineConfig, type EngineConfig } from './config'
import { initialSnapshot, type PlayerState } from './game'
import { canAffordMove, moveInCost, rentReserve } from './housing'

/** Fixed numbers so these tests do not move when balance.json is tuned. */
const config: EngineConfig = {
  ...engineConfig,
  rentPerWeek: { 'queens-room': 280, 'brooklyn-1br': 520, 'manhattan-loft': 1100 },
  housing: { moveInCost: { 'brooklyn-1br': 400, 'manhattan-loft': 1000 } },
}

function player(overrides: Partial<PlayerState>): PlayerState {
  return { ...initialSnapshot(config).player, ...overrides }
}

describe('move-in cost', () => {
  it('reads each home from config, and the lowest-rent home costs nothing', () => {
    expect(moveInCost('brooklyn-1br', config)).toBe(400)
    expect(moveInCost('manhattan-loft', config)).toBe(1000)
    expect(moveInCost('queens-room', config)).toBe(0)
  })
})

describe('rent reserve', () => {
  it('is this week’s rent for the current home plus anything owed', () => {
    expect(rentReserve(player({ home: 'queens-room' }), config)).toBe(280)
    expect(rentReserve(player({ home: 'brooklyn-1br' }), config)).toBe(520)
    const behind = player({ home: 'queens-room', rent: { owed: 310, missed: 1 } })
    expect(rentReserve(behind, config)).toBe(590)
  })
})

describe('affording a move', () => {
  it('needs the reserve plus the move-in cost, to the dollar', () => {
    expect(canAffordMove(player({ cash: 680 }), 'brooklyn-1br', config)).toBe(true)
    expect(canAffordMove(player({ cash: 679 }), 'brooklyn-1br', config)).toBe(false)
    expect(canAffordMove(player({ cash: 1279 }), 'manhattan-loft', config)).toBe(false)
    expect(canAffordMove(player({ cash: 1280 }), 'manhattan-loft', config)).toBe(true)
  })

  it('counts rent owed against the cash', () => {
    const behind = player({ cash: 680, rent: { owed: 1, missed: 1 } })
    expect(canAffordMove(behind, 'brooklyn-1br', config)).toBe(false)
  })

  it('a move to the lowest-rent home needs only the reserve', () => {
    expect(canAffordMove(player({ cash: 280 }), 'queens-room', config)).toBe(true)
    expect(canAffordMove(player({ cash: 279 }), 'queens-room', config)).toBe(false)
  })
})
