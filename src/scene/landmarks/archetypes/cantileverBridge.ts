/**
 * Cantilever bridge: piers from the water carrying truss towers, the deck rising from the land
 * at each end to its clearance at the outer piers, and a through truss each side of the deck
 * between the piers, tall over each pier and low mid-span.
 */
import type { ParamsOf } from '@/lib/data/schemas/landmarkModels'
import { beam, box, cable, taperedBox, type Vec3 } from '../kit/primitives'
import type { ArchetypeFrame, LodLevel, Part } from '../types'
import { deckBeams, deckProfile, onAxis } from './bridgeDeck'

const MEMBER_M = 0.8
const LEG_SHARE = 0.18
const CROSSBEAM_M = 3
const TRUSS_OUTSET_M = 0.5
const L1_CHORD_SEGMENTS = 4

export function cantileverBridge(
  p: ParamsOf<'cantileverBridge'>,
  level: LodLevel,
  frame: ArchetypeFrame,
): Part[] {
  const { deck, piers, truss } = p
  const pierS = piers.offsetsM
  const profile = deckProfile(frame, pierS, deck.clearanceM)
  const pierRole = { role: p.roles.pier }
  const pierBox = (s: number, x0: number, x1: number, y0: number, y1: number) =>
    box(onAxis(s + piers.depthM / 2, y0, x0), onAxis(s - piers.depthM / 2, y1, x1), pierRole)
  const half = piers.widthM / 2
  const first = pierS[0] ?? 0
  const last = pierS[pierS.length - 1] ?? 0

  if (level === 2) {
    return [
      ...deckBeams(
        [
          [first, deck.clearanceM],
          [last, deck.clearanceM],
        ],
        deck.widthM,
        deck.thicknessM,
        p.roles.deck,
      ),
      ...pierS.map((s) => pierBox(s, -half, half, 0, piers.heightM)),
    ]
  }

  const parts: Part[] = deckBeams(profile, deck.widthM, deck.thicknessM, p.roles.deck)
  const deckBottom = deck.clearanceM - deck.thicknessM
  const towerTop = piers.heightM - piers.finialM
  const leg = piers.widthM * LEG_SHARE
  for (const s of pierS) {
    parts.push(pierBox(s, -half, half, 0, deckBottom))
    if (level === 1) {
      parts.push(pierBox(s, -half, half, deck.clearanceM, piers.heightM))
      continue
    }
    for (const x of [-half, half - leg]) {
      parts.push(pierBox(s, x, x + leg, deck.clearanceM, towerTop))
      parts.push(
        taperedBox(
          [x + leg / 2, -s],
          towerTop,
          piers.heightM,
          [leg, piers.depthM],
          [leg * 0.15, piers.depthM * 0.15],
          pierRole,
        ),
      )
    }
    parts.push(pierBox(s, -half + leg, half - leg, towerTop - CROSSBEAM_M, towerTop))
  }

  // The truss: a top chord over each side of the deck, high over the piers, low mid-span.
  const chordY = (s: number) => {
    for (let i = 1; i < pierS.length; i++) {
      const a = pierS[i - 1] ?? 0
      const b = pierS[i] ?? 0
      if (s <= b) {
        const u = (s - a) / (b - a)
        return (
          deck.clearanceM + truss.midHeightM + (truss.heightM - truss.midHeightM) * (2 * u - 1) ** 2
        )
      }
    }
    return deck.clearanceM + truss.heightM
  }
  const panelPoints: number[] = []
  for (let i = 1; i < pierS.length; i++) {
    const a = pierS[i - 1] ?? 0
    const b = pierS[i] ?? 0
    const panels = level === 0 ? Math.max(2, Math.round((b - a) / truss.panelM)) : L1_CHORD_SEGMENTS
    for (let k = i === 1 ? 0 : 1; k <= panels; k++) panelPoints.push(a + ((b - a) * k) / panels)
  }
  const trussRole = { role: p.roles.truss, outline: false }
  for (const side of [-1, 1]) {
    const x = side * (deck.widthM / 2 + TRUSS_OUTSET_M)
    const chord: Vec3[] = panelPoints.map((s) => onAxis(s, chordY(s), x))
    parts.push(cable(chord, MEMBER_M, p.roles.truss))
    if (level === 1) continue
    panelPoints.forEach((s, k) => {
      parts.push(
        beam(onAxis(s, deck.clearanceM, x), onAxis(s, chordY(s), x), MEMBER_M, MEMBER_M, trussRole),
      )
      const next = panelPoints[k + 1]
      if (next !== undefined) {
        // Diagonals lean toward the nearer pier, as in a cantilever arm.
        const towardStart = chordY(s) > chordY(next)
        const from = towardStart ? onAxis(s, chordY(s), x) : onAxis(s, deck.clearanceM, x)
        const to = towardStart ? onAxis(next, deck.clearanceM, x) : onAxis(next, chordY(next), x)
        parts.push(beam(from, to, MEMBER_M, MEMBER_M, trussRole))
      }
    })
  }
  return parts
}
