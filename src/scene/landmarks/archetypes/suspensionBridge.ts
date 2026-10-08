/**
 * Suspension bridge: two towers standing on piers from the water, the deck rising from the
 * land at each end to its clearance at the towers, main cables hanging between the tower tops
 * and back down to the ends, and vertical hangers to the deck.
 */
import type { ParamsOf } from '@/lib/data/schemas/landmarkModels'
import { arcade, box, cable, beam, sampleCatenary, type Vec3 } from '../kit/primitives'
import type { ArchetypeFrame, LodLevel, Part } from '../types'
import { deckBeams, deckProfile, onAxis } from './bridgeDeck'

const PIER_MARGIN_M = 1
const CABLE_M = 0.8
const HANGER_M = 0.35
/** Main cables hang from just under the tower top and dip to this height over the deck. */
const CABLE_TOP_DROP_M = 1
const CABLE_LOW_ABOVE_DECK_M = 2
const CABLE_SPACING_M = 1.8
const LINTEL_M = 2

export function suspensionBridge(
  p: ParamsOf<'suspensionBridge'>,
  level: LodLevel,
  frame: ArchetypeFrame,
): Part[] {
  const { deck, towers } = p
  const towerS = towers.offsetsM
  const profile = deckProfile(frame, towerS, deck.clearanceM)
  const towerRole = { role: p.roles.tower }
  const towerBox = (s: number, y0: number, y1: number, grow = 0) =>
    box(
      onAxis(s + towers.depthM / 2 + grow, y0, -towers.widthM / 2 - grow),
      onAxis(s - towers.depthM / 2 - grow, y1, towers.widthM / 2 + grow),
      towerRole,
    )

  const parts: Part[] = deckBeams(profile, deck.widthM, deck.thicknessM, p.roles.deck)
  if (level === 2) {
    for (const s of towerS) parts.push(towerBox(s, 0, towers.heightM))
    return parts
  }

  const deckBottom = deck.clearanceM - deck.thicknessM
  for (const s of towerS) {
    parts.push(towerBox(s, 0, towers.pierHeightM, PIER_MARGIN_M))
    if (level === 1) {
      parts.push(towerBox(s, towers.pierHeightM, towers.heightM))
      continue
    }
    // The tower: solid below the deck, an arcade the deck runs through, a solid top.
    const openingTop = deck.clearanceM + 0.55 * (towers.heightM - deck.clearanceM)
    parts.push(towerBox(s, towers.pierHeightM, deckBottom))
    parts.push(
      arcade(
        -towers.widthM / 2,
        towers.widthM / 2,
        towers.openings,
        deckBottom,
        openingTop,
        -(s + towers.depthM / 2),
        -(s - towers.depthM / 2),
        towers.legWidthM,
        LINTEL_M,
        towerRole,
      ),
    )
    parts.push(towerBox(s, openingTop + LINTEL_M, towers.heightM))
  }

  // Main cables: per side, `perSide` (L0) or one (L1), hanging tower to tower and to the ends.
  const [t0, t1] = towerS as [number, number]
  const half = frame.spanM / 2
  const cableTop = towers.heightM - CABLE_TOP_DROP_M
  const sag = cableTop - (deck.clearanceM + CABLE_LOW_ABOVE_DECK_M)
  const anchorY = frame.landTopY + CABLE_LOW_ABOVE_DECK_M
  const perSide = level === 0 ? p.cables.perSide : 1
  const mainSegments = level === 0 ? 12 : 8
  const sideSegments = level === 0 ? 5 : 3
  for (const side of [-1, 1]) {
    for (let j = 0; j < perSide; j++) {
      const x = side * (deck.widthM / 2 + 0.6 + j * CABLE_SPACING_M)
      const top0: Vec3 = onAxis(t0, cableTop, x)
      const top1: Vec3 = onAxis(t1, cableTop, x)
      const backSag = 0.03 * (t0 + half)
      const foreSag = 0.03 * (half - t1)
      parts.push(cable(sampleCatenary(top0, top1, sag, mainSegments), CABLE_M, p.roles.cable))
      parts.push(
        cable(
          sampleCatenary(onAxis(-half, anchorY, x), top0, backSag, sideSegments),
          CABLE_M,
          p.roles.cable,
        ),
      )
      parts.push(
        cable(
          sampleCatenary(top1, onAxis(half, anchorY, x), foreSag, sideSegments),
          CABLE_M,
          p.roles.cable,
        ),
      )
    }
  }
  if (level === 1) return parts

  // Hangers from the outermost cable down to the deck edge, across the main span.
  const count = Math.floor((t1 - t0) / p.cables.hangerSpacingM)
  for (const side of [-1, 1]) {
    const x = side * (deck.widthM / 2 + 0.6)
    for (let k = 1; k < count; k++) {
      const s = t0 + k * p.cables.hangerSpacingM
      const u = (s - t0) / (t1 - t0)
      const cableY = cableTop - 4 * sag * u * (1 - u)
      parts.push(
        beam(onAxis(s, deck.clearanceM, x), onAxis(s, cableY, x), HANGER_M, HANGER_M, {
          role: p.roles.cable,
          outline: false,
        }),
      )
    }
  }
  return parts
}
