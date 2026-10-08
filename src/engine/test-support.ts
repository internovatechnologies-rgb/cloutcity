/**
 * Helpers for engine tests (not used by the game). Clout is derived from the ledger, so tests
 * that need a player at some clout build the ledger through these instead of setting a number.
 */
import { cloutLevel, itemClout, legacyCloutState } from './clout'
import type { EngineConfig } from './config'
import type { GameSnapshot, PlayerState } from './game'
import { homeClout } from './home'
import { buyAtShop, performPlaceAction, placeActions, shopBlock } from './placeActions'
import type { Place } from './places'

/**
 * `player` holding `total` clout: earned clout becomes one folded legacy entry (less what their
 * wearables and home already carry), and the level it lands on counts as reached (no level-up
 * for it).
 */
export function playerWithClout<P extends PlayerState>(
  player: P,
  total: number,
  config: EngineConfig,
): P {
  const earned = Math.max(0, total - itemClout(player, config) - homeClout(player, config))
  const clout = {
    ...legacyCloutState(earned, cloutLevel(total, config).index),
    firstPaycheckPaid: player.clout.firstPaycheckPaid,
  }
  return { ...player, clout }
}

/** `snapshot` with its player holding `total` clout (see `playerWithClout`). */
export function withClout(
  snapshot: GameSnapshot,
  total: number,
  config: EngineConfig,
): GameSnapshot {
  return { ...snapshot, player: playerWithClout(snapshot.player, total, config) }
}

/** `snapshot` with the player standing at the place `placeId` (DEC-22: its actions need them there). */
export function atPlace<S extends GameSnapshot>(snapshot: S, placeId: string): S {
  return { ...snapshot, player: { ...snapshot.player, location: { kind: 'place', placeId } } }
}

/**
 * The place rules as the player sees them standing at the place (DEC-22): for tests about a
 * place's own rules (hours, door, funds, limits), not about getting there.
 */
export function placeActionsHere(place: Place, snapshot: GameSnapshot, config: EngineConfig) {
  return placeActions(place, atPlace(snapshot, place.id), config)
}

/** `performPlaceAction` standing at the place (see `placeActionsHere`). */
export function performPlaceActionHere(
  snapshot: GameSnapshot,
  place: Place,
  actionId: string,
  config: EngineConfig,
) {
  return performPlaceAction(atPlace(snapshot, place.id), place, actionId, config)
}

/** `shopBlock` standing at the place (see `placeActionsHere`). */
export function shopBlockHere(place: Place, snapshot: GameSnapshot, config: EngineConfig) {
  return shopBlock(place, atPlace(snapshot, place.id), config)
}

/** `buyAtShop` standing at the place (see `placeActionsHere`). */
export function buyAtShopHere(
  snapshot: GameSnapshot,
  place: Place,
  itemId: string,
  config: EngineConfig,
) {
  return buyAtShop(atPlace(snapshot, place.id), place, itemId, config)
}
