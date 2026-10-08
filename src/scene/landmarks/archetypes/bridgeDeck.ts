/**
 * What both bridge archetypes share. Model space for a bridge: the axis runs along z, its first
 * end at z = +span/2 and its second at z = -span/2 (the heading points from the first end to
 * the second, and the model's front faces -z). `s` is the distance along the axis from the
 * anchor toward the second end, so z = -s.
 */
import { beam, type Vec3 } from '../kit/primitives'
import type { ArchetypeFrame, Part } from '../types'
import type { PartRole } from '@/lib/data/schemas/landmarkModels'

/** Model-space point at axis position `s`, height `y`, `x` metres right of the axis. */
export const onAxis = (s: number, y: number, x = 0): Vec3 => [x, y, -s]

/** A deck profile: (s, deck top y) points from the first end to the second. */
export type DeckProfile = readonly (readonly [number, number])[]

/**
 * The deck rises from the land top at both ends to `clearanceM` at the first and last support
 * and stays level between them.
 */
export function deckProfile(
  frame: ArchetypeFrame,
  supportsS: readonly number[],
  clearanceM: number,
): DeckProfile {
  const half = frame.spanM / 2
  const first = supportsS[0]
  const last = supportsS[supportsS.length - 1]
  if (first === undefined || last === undefined || first <= -half || last >= half) {
    throw new Error(`bridge supports must stand between the ends (±${half} m)`)
  }
  return [
    [-half, frame.landTopY],
    ...supportsS.map((s) => [s, clearanceM] as const),
    [half, frame.landTopY],
  ]
}

/** One beam per profile segment, `thicknessM` deep under the profile line. */
export function deckBeams(
  profile: DeckProfile,
  widthM: number,
  thicknessM: number,
  role: PartRole,
): Part[] {
  const parts: Part[] = []
  for (let i = 1; i < profile.length; i++) {
    const [s0, y0] = profile[i - 1] ?? [0, 0]
    const [s1, y1] = profile[i] ?? [0, 0]
    if (s1 - s0 < 1e-6) continue
    parts.push(
      beam(onAxis(s0, y0 - thicknessM / 2), onAxis(s1, y1 - thicknessM / 2), widthM, thicknessM, {
        role,
      }),
    )
  }
  return parts
}
