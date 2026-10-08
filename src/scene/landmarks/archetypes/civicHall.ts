/**
 * Civic hall (government): a main block with an optional wing each side, a columned portico
 * on its front, an optional pediment over the portico and an optional cupola on the roof.
 */
import type { ParamsOf } from '@/lib/data/schemas/landmarkModels'
import {
  box,
  boxFaceWindows,
  cylinder,
  dome,
  gable,
  ngon,
  loft,
  type Vec3,
} from '../kit/primitives'
import type { ArchetypeFrame, LodLevel, Part } from '../types'

const CORNICE_M = 1.2
const CORNICE_OVERHANG_M = 0.6
const STYLOBATE_M = 1.2
const ENTABLATURE_M = 1.6

export function civicHall(
  p: ParamsOf<'civicHall'>,
  level: LodLevel,
  frame: ArchetypeFrame,
): Part[] {
  const y0 = frame.landTopY
  const body = { role: p.roles.body }
  const trim = { role: p.roles.trim }
  const roof = { role: p.roles.roof }
  const main = {
    min: [-p.widthM / 2, y0, -p.depthM / 2],
    max: [p.widthM / 2, y0 + p.heightM, p.depthM / 2],
  } as const
  const wings = p.wings
    ? [-1, 1].map((side) => {
        const w = p.wings
        const cx = side * (p.widthM / 2 + (w?.widthM ?? 0) / 2)
        const half = (w?.widthM ?? 0) / 2
        return {
          min: [cx - half, y0, -(w?.depthM ?? 0) / 2] as Vec3,
          max: [cx + half, y0 + (w?.heightM ?? 0), (w?.depthM ?? 0) / 2] as Vec3,
        }
      })
    : []

  const parts: Part[] = [box(main.min, main.max, body)]
  for (const wing of wings) parts.push(box(wing.min, wing.max, body))
  if (level === 2) return parts

  const front = -p.depthM / 2
  const porticoFront = front - p.portico.depthM
  const porticoTop = y0 + p.portico.heightM
  const cornice = (min: Vec3, max: Vec3) =>
    box(
      [min[0] - CORNICE_OVERHANG_M, max[1] - CORNICE_M, min[2] - CORNICE_OVERHANG_M],
      [max[0] + CORNICE_OVERHANG_M, max[1], max[2] + CORNICE_OVERHANG_M],
      trim,
    )
  parts.push(cornice(main.min, main.max))
  for (const wing of wings) parts.push(cornice(wing.min, wing.max))
  if (p.pediment) {
    parts.push(
      gable(
        -p.portico.widthM / 2,
        p.portico.widthM / 2,
        porticoFront,
        front,
        porticoTop,
        p.pediment.heightM,
        'z',
        trim,
      ),
    )
  }

  const cupola = p.cupola
  if (level === 1) {
    parts.push(
      box(
        [-p.portico.widthM / 2, y0, porticoFront],
        [p.portico.widthM / 2, porticoTop, front],
        trim,
      ),
    )
    if (cupola) {
      const drumTop = main.max[1] + cupola.drumHeightM
      parts.push(cylinder([0, 0], cupola.radiusM, main.max[1], drumTop, 6, body, { top: false }))
      parts.push(
        loft(
          ngon([0, 0], cupola.radiusM, 6),
          drumTop,
          ngon([0, 0], 0, 6),
          drumTop + cupola.domeHeightM,
          roof,
        ),
      )
    }
    return parts
  }

  // Portico: a stylobate, a row of columns and an entablature under the pediment.
  parts.push(
    box(
      [-p.portico.widthM / 2, y0, porticoFront],
      [p.portico.widthM / 2, y0 + STYLOBATE_M, front],
      trim,
    ),
  )
  parts.push(
    box(
      [-p.portico.widthM / 2, porticoTop - ENTABLATURE_M, porticoFront],
      [p.portico.widthM / 2, porticoTop, front],
      trim,
    ),
  )
  const spacing = p.portico.widthM / p.portico.columns
  const radius = Math.min(spacing * 0.25, p.portico.depthM * 0.25)
  for (let i = 0; i < p.portico.columns; i++) {
    const x = -p.portico.widthM / 2 + spacing * (i + 0.5)
    parts.push(
      cylinder(
        [x, porticoFront + radius * 1.5],
        radius,
        y0 + STYLOBATE_M,
        porticoTop - ENTABLATURE_M,
        6,
        trim,
        { top: false },
      ),
    )
  }
  if (cupola) {
    const drumTop = main.max[1] + cupola.drumHeightM
    parts.push(
      cylinder([0, 0], cupola.radiusM, main.max[1], drumTop, cupola.sides, body, { top: false }),
    )
    parts.push(dome([0, 0], cupola.radiusM, drumTop, cupola.domeHeightM, cupola.sides, 3, roof))
  }
  const margins = { bottomM: STYLOBATE_M, topM: CORNICE_M }
  for (const face of ['-z', '+z'] as const) {
    parts.push(boxFaceWindows(main.min, main.max, face, p.floors, p.windowColumns, margins))
    for (const wing of wings) {
      parts.push(
        boxFaceWindows(
          wing.min,
          wing.max,
          face,
          p.wings?.floors ?? 1,
          p.wings?.windowColumns ?? 1,
          margins,
        ),
      )
    }
  }
  return parts
}
