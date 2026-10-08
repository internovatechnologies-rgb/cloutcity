/**
 * Which pin a tap on the 3D map means (S04c). Screen-space, so a pin's tap target is the same
 * size at every zoom: anything within `hitRadiusPx` of its head counts (the schema keeps that at
 * least 22 px, a target at least 44 px across). When several pins are within `ambiguityPx` of the
 * nearest one, the tap cannot tell them apart, and the Places panel offers a choice instead of
 * guessing. Pure, no three or DOM.
 */
export interface ScreenPin {
  readonly id: string
  /** CSS pixels, in the same space as the tap point. */
  readonly x: number
  readonly y: number
}

export interface PickOptions {
  readonly hitRadiusPx: number
  readonly ambiguityPx: number
}

export type PickResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly id: string }
  /** Nearest first. */
  | { readonly kind: 'many'; readonly ids: readonly string[] }

export function pickPin(
  pins: readonly ScreenPin[],
  point: { readonly x: number; readonly y: number },
  { hitRadiusPx, ambiguityPx }: PickOptions,
): PickResult {
  const hits = pins
    .map((pin) => ({ id: pin.id, distance: Math.hypot(pin.x - point.x, pin.y - point.y) }))
    .filter((hit) => hit.distance <= hitRadiusPx)
    // Ties keep layer order (Array.prototype.sort is stable), so a pick is deterministic.
    .sort((a, b) => a.distance - b.distance)
  const nearest = hits[0]
  if (nearest === undefined) return { kind: 'none' }
  const close = hits.filter((hit) => hit.distance - nearest.distance <= ambiguityPx)
  return close.length === 1
    ? { kind: 'one', id: nearest.id }
    : { kind: 'many', ids: close.map((hit) => hit.id) }
}
