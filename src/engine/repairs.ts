/**
 * The repairs save plausibility (src/engine/plausibility.ts) makes to an uploaded save. Kept on
 * their own so the device can apply the server's repairs (src/state/store.ts `applyRepairs`)
 * without loading the checks.
 */
import { initialGoalsState } from './goals'
import { isPrestigeKept } from './items'
import type { SaveState } from './save'

/** A change `applyRepairs` makes to an uploaded save. */
export type Repair =
  /** `victory` drops the Icon moment with it. */
  | { readonly kind: 'drop-goal'; readonly goalId: string; readonly victory: boolean }
  | { readonly kind: 'drop-badge'; readonly badge: string }
  | { readonly kind: 'mark-kept'; readonly itemId: string }
  | { readonly kind: 'set-peak'; readonly peakLevel: number }
  /** Premium clout of one item, or (null) premium folded in from earlier runs. */
  | { readonly kind: 'drop-premium'; readonly itemId: string | null }

/** Applies `repairs` to `save`. Pure and idempotent: applying them twice changes nothing more. */
export function applyRepairs(save: SaveState, repairs: readonly Repair[]): SaveState {
  return repairs.reduce(applyRepair, save)
}

function applyRepair(save: SaveState, repair: Repair): SaveState {
  const { player } = save
  switch (repair.kind) {
    case 'drop-goal': {
      if (!Object.hasOwn(save.goals.achieved, repair.goalId)) return save
      const achieved = Object.fromEntries(
        Object.entries(save.goals.achieved).filter(([id]) => id !== repair.goalId),
      )
      // The Icon moment belongs to the victory goal: it goes with it.
      const icon = repair.victory ? initialGoalsState.icon : save.goals.icon
      return { ...save, goals: { ...save.goals, achieved, icon } }
    }
    case 'drop-badge':
      if (!save.prestige.badges.includes(repair.badge)) return save
      return {
        ...save,
        prestige: {
          ...save.prestige,
          badges: save.prestige.badges.filter((badge) => badge !== repair.badge),
        },
      }
    case 'mark-kept': {
      const wearables = player.inventory.wearables.map((owned) =>
        owned.itemId === repair.itemId && !isPrestigeKept(owned)
          ? { ...owned, worn: true, prestigeKept: true as const }
          : owned,
      )
      // Decor kept through prestige is a look only too (H-4).
      const decor = player.inventory.decor.map((owned) =>
        owned.itemId === repair.itemId && !isPrestigeKept(owned)
          ? { ...owned, prestigeKept: true as const }
          : owned,
      )
      return {
        ...save,
        player: { ...player, inventory: { ...player.inventory, wearables, decor } },
      }
    }
    case 'set-peak':
      return {
        ...save,
        player: { ...player, clout: { ...player.clout, peakLevel: repair.peakLevel } },
      }
    case 'drop-premium': {
      const { clout } = player
      if (repair.itemId === null) {
        const bySource = Object.fromEntries(
          Object.entries(clout.compacted.bySource).filter(([source]) => source !== 'premium'),
        )
        return {
          ...save,
          player: { ...player, clout: { ...clout, compacted: { ...clout.compacted, bySource } } },
        }
      }
      const ledger = clout.ledger.filter(
        (entry) => entry.source !== 'premium' || entry.ref.itemId !== repair.itemId,
      )
      return { ...save, player: { ...player, clout: { ...clout, ledger } } }
    }
  }
}
