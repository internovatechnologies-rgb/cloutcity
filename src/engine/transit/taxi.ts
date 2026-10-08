/**
 * Taxi paths: straight when the drive stays on land, otherwise via bridges and vehicle tunnels
 * (`transit.crossings`). The path is the shortest chain from → crossing → … → to in which every
 * stretch between crossings passes the water test; crossings themselves span the water.
 * Road waypoints (`transit.roadWaypoints`) are points on land the drive may also pass through,
 * so a straight stretch can bend around a bay (Gravesend Bay, the Staten Island shore).
 *
 * Search is A* over the crossing ends (straight-line distance to the destination is the
 * heuristic, so it is exact). Stretches between two crossing ends do not depend on the trip and
 * are memoised on the prepared crossings, so repeat trips only test their own two ends.
 */
import { distanceM, project, type LatLng, type LocalPoint } from '@/lib/geo/projection'
import { crossesWater, type LandMask } from './land'

export interface CrossingDef {
  readonly id: string
  readonly a: LatLng
  readonly b: LatLng
}

export interface RoadWaypointDef {
  readonly id: string
  readonly at: LatLng
}

export interface PreparedCrossings {
  readonly land: LandMask
  readonly maxWaterM: number
  /**
   * Node 2k is crossing k's end a, node 2k + 1 its end b; road waypoints follow from node
   * `spanNodes` on.
   */
  readonly ends: readonly LocalPoint[]
  /** Nodes below this are crossing ends (they pair up across the water). */
  readonly spanNodes: number
  readonly ids: readonly string[]
  /** Memo of dry stretches between two crossing ends, keyed "i|j" with i < j. */
  readonly dryLinks: Map<string, boolean>
}

export function prepareCrossings(
  crossings: readonly CrossingDef[],
  waypoints: readonly RoadWaypointDef[],
  land: LandMask,
  maxWaterM: number,
): PreparedCrossings {
  return {
    land,
    maxWaterM,
    ends: [
      ...crossings.flatMap((crossing) => [project(crossing.a), project(crossing.b)]),
      ...waypoints.map((waypoint) => project(waypoint.at)),
    ],
    spanNodes: crossings.length * 2,
    ids: crossings.map((crossing) => crossing.id),
    dryLinks: new Map(),
  }
}

export interface TaxiPath {
  /** from, the crossing ends in order, to. */
  readonly points: readonly LocalPoint[]
  readonly crossingIds: readonly string[]
  readonly lengthM: number
}

/** The shortest drivable path, or undefined when no chain of crossings reaches `to`. */
export function taxiPath(
  from: LocalPoint,
  to: LocalPoint,
  prepared: PreparedCrossings,
): TaxiPath | undefined {
  const { land, maxWaterM, ends } = prepared
  const dry = (a: LocalPoint, b: LocalPoint) => !crossesWater(a, b, land, maxWaterM)
  if (dry(from, to)) return { points: [from, to], crossingIds: [], lengthM: distanceM(from, to) }

  // Nodes: 0..n-1 crossing ends, n the origin, n + 1 the destination.
  const n = ends.length
  const ORIGIN = n
  const TARGET = n + 1
  const pointOf = (node: number): LocalPoint =>
    node === ORIGIN ? from : node === TARGET ? to : (ends[node] ?? from)
  const dryBetween = (i: number, j: number): boolean => {
    if (i >= n || j >= n) return dry(pointOf(i), pointOf(j))
    const key = i < j ? `${i}|${j}` : `${j}|${i}`
    let value = prepared.dryLinks.get(key)
    if (value === undefined) {
      value = dry(pointOf(i), pointOf(j))
      prepared.dryLinks.set(key, value)
    }
    return value
  }

  const best = new Float64Array(n + 2).fill(Infinity)
  const prev = new Int32Array(n + 2).fill(-1)
  const done = new Uint8Array(n + 2)
  best[ORIGIN] = 0
  const heuristic = (node: number) => distanceM(pointOf(node), to)

  for (;;) {
    // n is small (two ends per crossing), so a linear scan beats a heap.
    let node = -1
    let nodeScore = Infinity
    for (let i = 0; i < n + 2; i++) {
      if (done[i]) continue
      const g = best[i] ?? Infinity
      if (g === Infinity) continue
      const score = g + heuristic(i)
      if (score < nodeScore) {
        nodeScore = score
        node = i
      }
    }
    if (node === -1) return undefined
    if (node === TARGET) break
    done[node] = 1
    const g = best[node] ?? Infinity
    const relax = (next: number, cost: number) => {
      if (done[next] || cost >= (best[next] ?? Infinity)) return
      best[next] = cost
      prev[next] = node
    }
    // Across this crossing to its other end.
    if (node < prepared.spanNodes) {
      const partner = node % 2 === 0 ? node + 1 : node - 1
      relax(partner, g + distanceM(pointOf(node), pointOf(partner)))
    }
    // Along dry land to the destination or to any crossing end.
    for (const next of [TARGET, ...ends.keys()]) {
      if (next === node || done[next]) continue
      const cost = g + distanceM(pointOf(node), pointOf(next))
      if (cost >= (best[next] ?? Infinity)) continue
      if (dryBetween(node, next)) relax(next, cost)
    }
  }

  const nodes: number[] = []
  for (let node = TARGET; node !== -1; node = prev[node] ?? -1) nodes.push(node)
  nodes.reverse()
  const crossingIds: string[] = []
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1] ?? -1
    const b = nodes[i] ?? -1
    const span = prepared.spanNodes
    if (a < span && b < span && a !== b && Math.floor(a / 2) === Math.floor(b / 2)) {
      crossingIds.push(prepared.ids[Math.floor(a / 2)] ?? '')
    }
  }
  return { points: nodes.map(pointOf), crossingIds, lengthM: best[TARGET] ?? Infinity }
}
