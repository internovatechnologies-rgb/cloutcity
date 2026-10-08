/**
 * What the apartment's 3D chunk (S16) is given, as types only: the Home panel writes the view
 * (src/state/apartmentView.ts) without importing three, and the shell's mount passes it on.
 */
import type { DecorFit } from '@/engine/itemCatalog'
import type { HomeIdLiteral } from '@/lib/data/homes'
import type { QualityTier } from '@/lib/data/schemas/config'

/** What sits in a slot: the decor item and its colour variant's palette token. */
export interface ApartmentPlacement {
  readonly itemId: string
  readonly token: string
}

/** A tap on the room: on one slot, or ambiguous between several (nearest first). */
export type SlotTap =
  | { readonly kind: 'one'; readonly slotId: string }
  | { readonly kind: 'many'; readonly slotIds: readonly string[] }

/** What the room shows: everything the Home panel decides. */
export interface ApartmentView {
  readonly home: HomeIdLiteral
  /** Slot id → what is placed there. */
  readonly placed: Readonly<Record<string, ApartmentPlacement>>
  /** The kind of slot the held item fits (its markers light up), or null when nothing is held. */
  readonly heldKind: DecorFit | null
  readonly selectedSlotId: string | null
  /** The canvas's accessible name ("Your apartment, Queens room"). */
  readonly label: string
  /** The personal-clock minute, for the lighting seam (S04f). */
  readonly minute: number
  readonly tier: QualityTier
}

export interface ApartmentViewProps extends ApartmentView {
  readonly onSlotTap: (tap: SlotTap) => void
}
