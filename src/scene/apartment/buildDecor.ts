/**
 * Low-poly decor models (S16), code-built, one per decor item in data/items/items.json. Each is
 * one merged geometry with at most two material groups: group 0 in the colour variant the player
 * chose, group 1 (when the model has one) in a fixed second colour from the room palette. So a
 * placed item costs at most two draw calls (plus its shadow pass on the high tier).
 *
 * Models are built in their slot's frame: origin at the slot point, +z facing into the room. A
 * wall item hangs on the wall plane and stands out along +z; a floor or surface item stands on
 * y = 0. The scene turns each model by its slot's `rotationDeg` and moves it to the slot.
 */
import {
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  SphereGeometry,
  type BufferGeometry,
} from 'three'
import type { RoomPalette } from './data'
import { boxAt, mergeParts, part } from './parts'

/** The room palette colour a model's second material group takes. */
export type DecorSecondRole = keyof Pick<RoomPalette, 'trim' | 'furniture' | 'plant' | 'glow'>

export interface DecorModel {
  /** Groups: 0 the main (variant) colour, 1 the second colour when `second` is set. */
  readonly geometry: BufferGeometry
  readonly second: DecorSecondRole | null
  /** The main colour glows (bulbs, neon): drawn unlit instead of toon-shaded. */
  readonly glows: boolean
  /** Half the footprint's width, for the blob shadow under floor and surface items. */
  readonly footprintM: number
}

interface ModelParts {
  readonly main: readonly BufferGeometry[]
  readonly secondParts: readonly BufferGeometry[]
  readonly second: DecorSecondRole | null
  readonly glows: boolean
  readonly footprintM: number
}

/** A thin box from `a` to `b` (x, y) at depth `z`: a wire or neon tube segment. */
function segment(
  a: readonly [number, number],
  b: readonly [number, number],
  thickness: number,
  z: number,
): BufferGeometry {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  const piece = boxAt([length, thickness, thickness], [0, 0, 0])
  piece.rotateZ(Math.atan2(b[1] - a[1], b[0] - a[0]))
  piece.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z)
  return piece
}

/** A swag of bulbs on a wire across the wall. */
function fairyLights(): ModelParts {
  const bulbs = 9
  const width = 1.4
  const sag = 0.24
  const points = Array.from({ length: bulbs }, (_, i): [number, number] => {
    const t = i / (bulbs - 1)
    return [-width / 2 + t * width, -sag * 4 * t * (1 - t)]
  })
  return {
    main: points.map(([x, y]) => {
      const bulb = new IcosahedronGeometry(0.035, 0)
      bulb.translate(x, y - 0.03, 0.05)
      return bulb
    }),
    secondParts: points.slice(1).map((point, i) => segment(points[i] ?? point, point, 0.012, 0.04)),
    second: 'trim',
    glows: true,
    footprintM: width / 2,
  }
}

/** A potted plant: the pot in the variant colour, five leaves. */
function monstera(): ModelParts {
  const pot = new CylinderGeometry(0.1, 0.075, 0.17, 8)
  pot.translate(0, 0.085, 0)
  const leaves = [0, 1, 2, 3, 4].map((i) => {
    const leaf = new ConeGeometry(0.08, 0.3, 5)
    leaf.scale(1, 1, 0.35)
    leaf.rotateZ(((i - 2) * Math.PI) / 9)
    leaf.rotateY((i * Math.PI * 2) / 5)
    leaf.translate(0, 0.32, 0)
    return leaf
  })
  return { main: [pot], secondParts: leaves, second: 'plant', glows: false, footprintM: 0.14 }
}

/** A flat rug with three light stripes. */
function rug(): ModelParts {
  const width = 1.4
  const depth = 0.9
  return {
    main: [boxAt([width, 0.015, depth], [0, 0.0075, 0])],
    secondParts: [-0.27, 0, 0.27].map((z) => boxAt([width, 0.006, 0.08], [0, 0.017, z])),
    second: 'glow',
    glows: false,
    footprintM: width / 2,
  }
}

/** A record player on a milk crate: the deck in the variant colour, crate and platter dark. */
function recordPlayer(): ModelParts {
  const platter = new CylinderGeometry(0.11, 0.11, 0.012, 12)
  platter.translate(-0.04, 0.286, 0)
  return {
    main: [boxAt([0.38, 0.06, 0.3], [0, 0.25, 0])],
    secondParts: [
      boxAt([0.4, 0.22, 0.32], [0, 0.11, 0]),
      platter,
      boxAt([0.16, 0.012, 0.02], [0.1, 0.29, 0.06]),
    ],
    second: 'trim',
    glows: false,
    footprintM: 0.22,
  }
}

/** A neon lightning bolt with an underline on a dark backing board. */
function neonSign(): ModelParts {
  const bolt: [number, number][] = [
    [0.08, 0.2],
    [-0.1, 0.0],
    [0.06, 0.0],
    [-0.08, -0.18],
  ]
  return {
    main: [
      ...bolt.slice(1).map((point, i) => segment(bolt[i] ?? point, point, 0.035, 0.05)),
      segment([-0.3, -0.21], [0.3, -0.21], 0.03, 0.05),
    ],
    secondParts: [boxAt([0.9, 0.55, 0.03], [0, 0, 0.015])],
    second: 'trim',
    glows: true,
    footprintM: 0.45,
  }
}

/** A puffy lounge chair: cloud cushions in the variant colour on four short legs. */
function cloudChair(): ModelParts {
  const puff = (radius: number, at: readonly [number, number, number], squash = 0.7) => {
    const sphere = new SphereGeometry(radius, 8, 6)
    sphere.scale(1, squash, 1)
    sphere.translate(at[0], at[1], at[2])
    return sphere
  }
  const legs = [
    [-0.3, -0.25],
    [0.3, -0.25],
    [-0.3, 0.25],
    [0.3, 0.25],
  ].map(([x = 0, z = 0]) => {
    const leg = new CylinderGeometry(0.03, 0.03, 0.12, 6)
    leg.translate(x, 0.06, z)
    return leg
  })
  return {
    main: [
      puff(0.3, [-0.18, 0.26, 0.05]),
      puff(0.3, [0.18, 0.26, 0.05]),
      puff(0.28, [-0.2, 0.52, -0.22], 0.8),
      puff(0.28, [0.2, 0.52, -0.22], 0.8),
      puff(0.2, [0, 0.62, -0.25], 0.9),
    ],
    secondParts: legs,
    second: 'furniture',
    glows: false,
    footprintM: 0.45,
  }
}

const BUILDERS: Readonly<Record<string, () => ModelParts>> = {
  'fairy-string-lights': fairyLights,
  'windowsill-monstera': monstera,
  'thrift-flatweave-rug': rug,
  'crate-record-player': recordPlayer,
  'custom-neon-sign': neonSign,
  'cloud-lounge-chair': cloudChair,
}

/** The item ids that have a model (every decor item, checked in buildDecor.test.ts). */
export const DECOR_MODEL_IDS: readonly string[] = Object.keys(BUILDERS)

/** Builds one decor item's model, or null for an item with no model yet. */
export function buildDecorModel(itemId: string): DecorModel | null {
  const build = BUILDERS[itemId]
  if (build === undefined) return null
  const { main, secondParts, second, glows, footprintM } = build()
  const mainGeometry = mergeParts(main.map(part), `${itemId} main`)
  if (second === null || secondParts.length === 0) {
    return { geometry: mainGeometry, second: null, glows, footprintM }
  }
  const secondGeometry = mergeParts(secondParts.map(part), `${itemId} second`)
  return {
    geometry: mergeParts([mainGeometry, secondGeometry], itemId, true),
    second,
    glows,
    footprintM,
  }
}
