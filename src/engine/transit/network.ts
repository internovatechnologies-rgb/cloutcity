/**
 * The subway as a graph, built once from data/geo/subway.derived.json, and fastest-route search
 * over it.
 *
 * The derived file has line paths (polylines) and stations listing their lines, but no stop
 * order, so each line's stops are ordered by where they sit along each of its paths; consecutive
 * stops become ride edges. Separate GTFS stations close together (Times Sq's several platforms)
 * are joined by walking transfers.
 *
 * Search runs over (station, line) states in two layers: on the platform waiting for a line, and
 * on a train of that line. The trip starts on a platform of one of the stations nearest the
 * origin and may only end from a train, so every route rides at least once. Ties break on the
 * lower state index, which follows the data's station and line order: results are deterministic.
 *
 * The caller passes the subway data in. The browser should fetch it as a static asset; never
 * import the JSON (or src/lib/data/geo.ts) into shell code.
 */
import { decodePath, type DeltaPath } from '@/lib/geo/codec'
import { distanceM, type LocalPoint } from '@/lib/geo/projection'
import type { TransitConfig } from './config'
import { appendPath, locateOnPath, measurePath, subPath, type MeasuredPath } from './polyline'

/** The fields of the derived subway file the network uses. */
export interface SubwayData {
  readonly lines: readonly {
    readonly id: string
    readonly label: string
    readonly paths: readonly DeltaPath[]
  }[]
  readonly stations: readonly {
    readonly id: string
    readonly x: number
    readonly y: number
    readonly lines: readonly string[]
  }[]
}

export interface NetworkStation {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly lines: readonly string[]
}

interface RideEdge {
  readonly to: number
  readonly lengthM: number
  readonly path: MeasuredPath
  readonly fromArcM: number
  readonly toArcM: number
}

export interface TransitNetwork {
  readonly stations: readonly NetworkStation[]
  /** Line id to its label (plain text drawn in our own style, never an MTA bullet). */
  readonly lineLabels: ReadonlyMap<string, string>
  /** Station/line pairs the data lists but no path of that line passes near. */
  readonly orphans: readonly { readonly stationId: string; readonly lineId: string }[]
  readonly rideEdgeCount: number
  readonly walkTransferCount: number
  /** @internal search structures */
  readonly stateStation: readonly number[]
  readonly stateLine: readonly string[]
  readonly statesAt: readonly (readonly number[])[]
  readonly rides: readonly (readonly RideEdge[])[]
  readonly walks: readonly (readonly { readonly to: number; readonly distanceM: number }[])[]
}

/** Builds the graph. `snapM` and `transferWalkMaxM` come from `transit.subway`. */
/** True when a person can walk the straight line a→b (it does not cross open water). */
export type WalkableTest = (a: LocalPoint, b: LocalPoint) => boolean

/**
 * Builds the graph. `snapM` and `transferWalkMaxM` come from `transit.subway`; walking
 * transfers that `walkable` refuses (across water) are left out.
 */
export function buildTransitNetwork(
  data: SubwayData,
  subway: Pick<TransitConfig['subway'], 'stationSnapM' | 'transferWalkMaxM'>,
  walkable?: WalkableTest,
): TransitNetwork {
  const stations: NetworkStation[] = data.stations.map((station) => ({
    id: station.id,
    x: station.x,
    y: station.y,
    lines: [...station.lines],
  }))

  const stateStation: number[] = []
  const stateLine: string[] = []
  const stateIndex = new Map<string, number>()
  const statesAt: number[][] = stations.map(() => [])
  stations.forEach((station, s) => {
    for (const lineId of station.lines) {
      const key = `${s}|${lineId}`
      if (stateIndex.has(key)) continue
      stateIndex.set(key, stateStation.length)
      statesAt[s]?.push(stateStation.length)
      stateStation.push(s)
      stateLine.push(lineId)
    }
  })

  const rideByKey = new Map<string, RideEdge & { readonly from: number }>()
  const orphans: { stationId: string; lineId: string }[] = []
  const lineLabels = new Map<string, string>()

  for (const line of data.lines) {
    lineLabels.set(line.id, line.label)
    const paths = line.paths.map((encoded) => measurePath(decodePath(encoded)))
    const onLine = stations.flatMap((station, s) => (station.lines.includes(line.id) ? [s] : []))
    const placed = new Set<number>()
    for (const path of paths) {
      const stops: { s: number; arcM: number }[] = []
      for (const s of onLine) {
        const station = stations[s]
        if (station === undefined) continue
        const { offsetM, arcM } = locateOnPath(station, path)
        if (offsetM <= subway.stationSnapM) {
          stops.push({ s, arcM })
          placed.add(s)
        }
      }
      stops.sort((a, b) => a.arcM - b.arcM || a.s - b.s)
      for (let i = 1; i < stops.length; i++) {
        const a = stops[i - 1]
        const b = stops[i]
        if (a === undefined || b === undefined || a.s === b.s) continue
        addRide(a.s, a.arcM, b.s, b.arcM, path)
        addRide(b.s, b.arcM, a.s, a.arcM, path)
      }
    }
    for (const s of onLine) {
      const station = stations[s]
      if (!placed.has(s) && station) orphans.push({ stationId: station.id, lineId: line.id })
    }

    function addRide(
      from: number,
      fromArcM: number,
      to: number,
      toArcM: number,
      path: MeasuredPath,
    ) {
      const fromState = stateIndex.get(`${from}|${line.id}`)
      const toState = stateIndex.get(`${to}|${line.id}`)
      if (fromState === undefined || toState === undefined) return
      const key = `${fromState}>${toState}`
      const lengthM = Math.abs(toArcM - fromArcM)
      const existing = rideByKey.get(key)
      // Branches share track: keep the shortest stretch (the first path wins a tie).
      if (existing !== undefined && existing.lengthM <= lengthM) return
      rideByKey.set(key, { from: fromState, to: toState, lengthM, path, fromArcM, toArcM })
    }
  }

  const rides: RideEdge[][] = stateStation.map(() => [])
  for (const edge of [...rideByKey.values()].sort((a, b) => a.from - b.from || a.to - b.to)) {
    rides[edge.from]?.push(edge)
  }

  const walks: { to: number; distanceM: number }[][] = stations.map(() => [])
  let walkTransferCount = 0
  for (let a = 0; a < stations.length; a++) {
    for (let b = a + 1; b < stations.length; b++) {
      const sa = stations[a]
      const sb = stations[b]
      if (sa === undefined || sb === undefined) continue
      const d = distanceM(sa, sb)
      if (d > subway.transferWalkMaxM) continue
      if (walkable !== undefined && !walkable(sa, sb)) continue
      walks[a]?.push({ to: b, distanceM: d })
      walks[b]?.push({ to: a, distanceM: d })
      walkTransferCount++
    }
  }

  return {
    stations,
    lineLabels,
    orphans,
    rideEdgeCount: rideByKey.size,
    walkTransferCount,
    stateStation,
    stateLine,
    statesAt,
    rides,
    walks,
  }
}

/** How many of the nearest stations are checked for a dry walk before giving up. */
const MAX_ACCESS_CHECKS = 50

/**
 * Stations to try at one end: the `accessCandidates` nearest that can be walked to (`walkable`),
 * within `accessMaxM` except that the nearest walkable one is always included.
 */
export function accessStations(
  point: LocalPoint,
  network: TransitNetwork,
  subway: Pick<TransitConfig['subway'], 'accessCandidates' | 'accessMaxM'>,
  walkable?: WalkableTest,
): { readonly station: number; readonly distanceM: number }[] {
  const ranked = network.stations
    .map((station, index) => ({ station: index, distanceM: distanceM(point, station) }))
    .sort((a, b) => a.distanceM - b.distanceM || a.station - b.station)
  const chosen: { station: number; distanceM: number }[] = []
  for (const candidate of ranked.slice(0, MAX_ACCESS_CHECKS)) {
    if (chosen.length >= subway.accessCandidates) break
    if (chosen.length > 0 && candidate.distanceM > subway.accessMaxM) break
    const station = network.stations[candidate.station]
    if (station === undefined) continue
    if (walkable !== undefined && !walkable(point, station)) continue
    chosen.push(candidate)
  }
  return chosen
}

/** Minute costs of the search; the caller folds in walking speed and rush hour. */
export interface SearchCosts {
  /** Minutes to walk `metres` (street distance included). */
  readonly walkMin: (metres: number) => number
  /** Minutes on the train for a ride of `metres` between two consecutive stops. */
  readonly rideMin: (metres: number) => number
  readonly boardWaitMin: number
  readonly transferPenaltyMin: number
  /** Entry and exit walks must pass this (no walking across water). */
  readonly walkable?: WalkableTest
}

export type SubwayStep =
  | {
      readonly kind: 'ride'
      readonly lineId: string
      readonly from: number
      readonly to: number
      readonly minutes: number
      readonly lengthM: number
      readonly polyline: readonly LocalPoint[]
    }
  | {
      readonly kind: 'transfer'
      readonly from: number
      readonly to: number
      readonly walkM: number
      readonly minutes: number
    }

export interface SubwaySearchResult {
  /** Station indices boarded at and alighted from. */
  readonly entry: { readonly station: number; readonly walkM: number; readonly walkMin: number }
  readonly exit: { readonly station: number; readonly walkM: number; readonly walkMin: number }
  readonly steps: readonly SubwayStep[]
  readonly totalMin: number
}

/** A binary min-heap of node ids keyed by cost, ties to the lower id. */
class MinHeap {
  private readonly nodes: number[] = []
  private readonly costs: number[] = []

  get size(): number {
    return this.nodes.length
  }

  private less(i: number, j: number): boolean {
    const ci = this.costs[i] ?? Infinity
    const cj = this.costs[j] ?? Infinity
    return ci < cj || (ci === cj && (this.nodes[i] ?? 0) < (this.nodes[j] ?? 0))
  }

  private swap(i: number, j: number): void {
    const n = this.nodes[i] ?? 0
    const c = this.costs[i] ?? 0
    this.nodes[i] = this.nodes[j] ?? 0
    this.costs[i] = this.costs[j] ?? 0
    this.nodes[j] = n
    this.costs[j] = c
  }

  push(node: number, cost: number): void {
    this.nodes.push(node)
    this.costs.push(cost)
    let i = this.nodes.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.less(i, parent)) break
      this.swap(i, parent)
      i = parent
    }
  }

  pop(): { node: number; cost: number } | undefined {
    const node = this.nodes[0]
    const cost = this.costs[0]
    if (node === undefined || cost === undefined) return undefined
    const lastNode = this.nodes.pop() ?? 0
    const lastCost = this.costs.pop() ?? 0
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode
      this.costs[0] = lastCost
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        const right = left + 1
        let smallest = i
        if (left < this.nodes.length && this.less(left, smallest)) smallest = left
        if (right < this.nodes.length && this.less(right, smallest)) smallest = right
        if (smallest === i) break
        this.swap(i, smallest)
        i = smallest
      }
    }
    return { node, cost }
  }
}

type Prev =
  | { readonly kind: 'source'; readonly walkM: number; readonly walkMin: number }
  | {
      readonly kind: 'ride'
      readonly from: number
      readonly edge: RideEdge
      readonly minutes: number
    }
  | {
      readonly kind: 'transfer'
      readonly from: number
      readonly walkM: number
      readonly minutes: number
    }
  | {
      readonly kind: 'exit'
      readonly from: number
      readonly walkM: number
      readonly walkMin: number
    }

/**
 * Fastest subway trip from `from` to `to`, or undefined when no line links the two ends (for
 * example Staten Island, whose railway does not connect to the rest of the network).
 */
export function searchSubway(
  from: LocalPoint,
  to: LocalPoint,
  network: TransitNetwork,
  subway: Pick<TransitConfig['subway'], 'accessCandidates' | 'accessMaxM'>,
  costs: SearchCosts,
): SubwaySearchResult | undefined {
  const stateCount = network.stateStation.length
  // Node ids: platform states [0, n), train states [n, 2n), the destination 2n.
  const PLATFORM = 0
  const TRAIN = stateCount
  const SINK = 2 * stateCount
  const best = new Float64Array(SINK + 1).fill(Infinity)
  const prev: (Prev | undefined)[] = new Array<Prev | undefined>(SINK + 1)
  const heap = new MinHeap()

  const relax = (node: number, cost: number, via: Prev) => {
    if (cost >= (best[node] ?? Infinity)) return
    best[node] = cost
    prev[node] = via
    heap.push(node, cost)
  }

  for (const { station, distanceM: walkM } of accessStations(
    from,
    network,
    subway,
    costs.walkable,
  )) {
    const walkMin = costs.walkMin(walkM)
    for (const state of network.statesAt[station] ?? []) {
      relax(PLATFORM + state, walkMin + costs.boardWaitMin, { kind: 'source', walkM, walkMin })
    }
  }
  const exits = new Map<number, number>()
  for (const { station, distanceM: walkM } of accessStations(to, network, subway, costs.walkable)) {
    exits.set(station, walkM)
  }

  for (let next = heap.pop(); next !== undefined; next = heap.pop()) {
    const { node, cost } = next
    if (cost > (best[node] ?? Infinity)) continue
    if (node === SINK) break
    const onTrain = node >= TRAIN
    const state = onTrain ? node - TRAIN : node - PLATFORM
    const station = network.stateStation[state] ?? -1
    const lineId = network.stateLine[state]

    for (const edge of network.rides[state] ?? []) {
      const minutes = costs.rideMin(edge.lengthM)
      relax(TRAIN + edge.to, cost + minutes, { kind: 'ride', from: node, edge, minutes })
    }
    if (!onTrain) continue

    for (const other of network.statesAt[station] ?? []) {
      if (other === state) continue
      const minutes = costs.transferPenaltyMin
      relax(PLATFORM + other, cost + minutes, { kind: 'transfer', from: node, walkM: 0, minutes })
    }
    for (const walk of network.walks[station] ?? []) {
      const minutes = costs.walkMin(walk.distanceM) + costs.transferPenaltyMin
      for (const other of network.statesAt[walk.to] ?? []) {
        if (network.stateLine[other] === lineId) continue
        relax(PLATFORM + other, cost + minutes, {
          kind: 'transfer',
          from: node,
          walkM: walk.distanceM,
          minutes,
        })
      }
    }
    const exitM = exits.get(station)
    if (exitM !== undefined) {
      const walkMin = costs.walkMin(exitM)
      relax(SINK, cost + walkMin, { kind: 'exit', from: node, walkM: exitM, walkMin })
    }
  }

  const arrival = prev[SINK]
  if (arrival === undefined || arrival.kind !== 'exit') return undefined

  const stationOf = (node: number) =>
    network.stateStation[node >= TRAIN ? node - TRAIN : node - PLATFORM] ?? -1
  const steps: SubwayStep[] = []
  let node = arrival.from
  let entry: SubwaySearchResult['entry'] | undefined
  while (entry === undefined) {
    const step = prev[node]
    if (step === undefined || step.kind === 'exit') return undefined
    if (step.kind === 'source') {
      entry = { station: stationOf(node), walkM: step.walkM, walkMin: step.walkMin }
    } else if (step.kind === 'ride') {
      const lineId = network.stateLine[node - TRAIN] ?? ''
      steps.push({
        kind: 'ride',
        lineId,
        from: stationOf(step.from),
        to: stationOf(node),
        minutes: step.minutes,
        lengthM: step.edge.lengthM,
        polyline: subPath(step.edge.path, step.edge.fromArcM, step.edge.toArcM),
      })
      node = step.from
    } else {
      steps.push({
        kind: 'transfer',
        from: stationOf(step.from),
        to: stationOf(node),
        walkM: step.walkM,
        minutes: step.minutes,
      })
      node = step.from
    }
  }
  steps.reverse()
  return {
    entry,
    exit: { station: stationOf(arrival.from), walkM: arrival.walkM, walkMin: arrival.walkMin },
    steps,
    totalMin: best[SINK] ?? Infinity,
  }
}

/**
 * Joins the polylines of consecutive rides on one line into the leg's drawn path. Two rides can
 * come from different paths of the line (branches share stations, not vertices), so where one
 * ride's end and the next one's start are more than `pathJoinM` apart the path goes through the
 * station between them. Returns the points and the metres those joins add.
 */
export function joinRidePolylines(
  rides: readonly { readonly polyline: readonly LocalPoint[]; readonly from: number }[],
  network: TransitNetwork,
  pathJoinM: number,
): { readonly points: LocalPoint[]; readonly joinM: number } {
  const points: LocalPoint[] = []
  let joinM = 0
  for (const ride of rides) {
    const last = points[points.length - 1]
    const first = ride.polyline[0]
    if (last !== undefined && first !== undefined) {
      const gap = distanceM(last, first)
      const station = network.stations[ride.from]
      if (gap > pathJoinM && station !== undefined) {
        const via = { x: station.x, y: station.y }
        joinM += distanceM(last, via) + distanceM(via, first)
        points.push(via)
      } else {
        joinM += gap
      }
    }
    appendPath(points, ride.polyline)
  }
  return { points, joinM }
}
