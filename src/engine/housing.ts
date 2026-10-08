/**
 * Moving home: what it takes to afford a move (S12 measures it; S16 builds the move on it).
 *
 * A player can afford a move into a home when, after setting aside their rent reserve (rent owed
 * plus this week's rent for the home they live in now), they still hold the home's move-in cost
 * (data/config/balance.json `housing.moveInCost`). The lowest-rent home, where an eviction lands,
 * has no move-in cost.
 */
import type { EngineConfig, HomeId } from './config'
import type { PlayerState } from './game'
import { rentFor } from './rent'

/** Whole dollars needed, on top of the rent reserve, to move into `home`. */
export function moveInCost(home: HomeId, config: EngineConfig): number {
  return config.housing.moveInCost[home] ?? 0
}

/** Whole dollars the player must keep for rent: what they owe plus this week's rent. */
export function rentReserve(player: PlayerState, config: EngineConfig): number {
  return player.rent.owed + rentFor(player.home, config)
}

/** True when the player's cash covers their rent reserve plus the move-in cost of `to`. */
export function canAffordMove(player: PlayerState, to: HomeId, config: EngineConfig): boolean {
  return player.cash - rentReserve(player, config) >= moveInCost(to, config)
}
