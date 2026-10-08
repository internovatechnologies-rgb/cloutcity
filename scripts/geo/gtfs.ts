/**
 * Reads the parts of MTA static GTFS the geo build needs, straight from the zip in memory (the
 * raw file is never extracted to disk, so the cached copy stays exactly as downloaded).
 */
import { parse } from 'csv-parse/sync'
import { unzipSync } from 'fflate'
import { z } from 'zod'
import type { LatLng } from '../../src/lib/geo/projection.ts'

const REQUIRED_FILES = ['routes.txt', 'trips.txt', 'shapes.txt', 'stops.txt', 'stop_times.txt']

const nonEmpty = z.string().min(1)
const coordinate = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .transform(Number)

const RouteRowSchema = z.object({ route_id: nonEmpty, route_short_name: nonEmpty })
const TripRowSchema = z.object({ route_id: nonEmpty, trip_id: nonEmpty, shape_id: z.string() })
const ShapeRowSchema = z.object({
  shape_id: nonEmpty,
  shape_pt_sequence: z.string().regex(/^\d+$/).transform(Number),
  shape_pt_lat: coordinate,
  shape_pt_lon: coordinate,
})
const StopRowSchema = z.object({
  stop_id: nonEmpty,
  stop_name: nonEmpty,
  stop_lat: coordinate,
  stop_lon: coordinate,
  location_type: z.string(),
  parent_station: z.string(),
})
const StopTimeRowSchema = z.object({ trip_id: nonEmpty, stop_id: nonEmpty })

export interface GtfsRoute {
  readonly routeId: string
  readonly shortName: string
  /** Shape ids used by this route's trips, sorted. */
  readonly shapeIds: readonly string[]
}

export interface GtfsStation {
  readonly stopId: string
  readonly name: string
  readonly location: LatLng
  /** Route ids whose trips stop here (at any child platform), sorted. */
  readonly routeIds: readonly string[]
}

export interface GtfsSubway {
  /** Sorted by route id. */
  readonly routes: readonly GtfsRoute[]
  /** Points of each shape in sequence order. */
  readonly shapes: ReadonlyMap<string, readonly LatLng[]>
  /** Parent stations (location_type 1), sorted by stop id. */
  readonly stations: readonly GtfsStation[]
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function readTable<T extends z.ZodType>(
  files: Record<string, Uint8Array>,
  name: string,
  schema: T,
  pick?: (record: Record<string, string>) => Record<string, string>,
): z.output<T>[] {
  const bytes = files[name]
  if (bytes === undefined) throw new Error(`GTFS: ${name} missing from the zip`)
  const records = parse<Record<string, string>>(new TextDecoder().decode(bytes), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    ...(pick === undefined ? {} : { on_record: pick }),
  })
  const result = z.array(schema).safeParse(records)
  if (!result.success) throw new Error(`GTFS: invalid ${name}:\n${z.prettifyError(result.error)}`)
  return result.data
}

export function readGtfsSubway(zip: Uint8Array): GtfsSubway {
  const files = unzipSync(zip, { filter: (file) => REQUIRED_FILES.includes(file.name) })

  const routeRows = readTable(files, 'routes.txt', RouteRowSchema)
  const tripRows = readTable(files, 'trips.txt', TripRowSchema)
  const shapeRows = readTable(files, 'shapes.txt', ShapeRowSchema)
  const stopRows = readTable(files, 'stops.txt', StopRowSchema)
  // stop_times is by far the largest file; keep only the two columns used.
  const stopTimeRows = readTable(files, 'stop_times.txt', StopTimeRowSchema, (record) => ({
    trip_id: record.trip_id ?? '',
    stop_id: record.stop_id ?? '',
  }))

  const routeIds = new Set(routeRows.map((row) => row.route_id))
  const tripRoute = new Map<string, string>()
  const routeShapes = new Map<string, Set<string>>()
  for (const trip of tripRows) {
    if (!routeIds.has(trip.route_id)) {
      throw new Error(`GTFS: trip ${trip.trip_id} names unknown route ${trip.route_id}`)
    }
    tripRoute.set(trip.trip_id, trip.route_id)
    if (trip.shape_id === '') continue
    const set = routeShapes.get(trip.route_id) ?? new Set<string>()
    set.add(trip.shape_id)
    routeShapes.set(trip.route_id, set)
  }

  const shapePoints = new Map<string, { seq: number; point: LatLng }[]>()
  for (const row of shapeRows) {
    const list = shapePoints.get(row.shape_id) ?? []
    list.push({
      seq: row.shape_pt_sequence,
      point: { lat: row.shape_pt_lat, lng: row.shape_pt_lon },
    })
    shapePoints.set(row.shape_id, list)
  }
  const shapes = new Map<string, readonly LatLng[]>()
  for (const id of [...shapePoints.keys()].sort(byString)) {
    const list = shapePoints.get(id) ?? []
    shapes.set(
      id,
      [...list].sort((a, b) => a.seq - b.seq).map((entry) => entry.point),
    )
  }
  for (const [routeId, ids] of routeShapes) {
    for (const id of ids) {
      if (!shapes.has(id)) throw new Error(`GTFS: route ${routeId} uses missing shape ${id}`)
    }
  }

  const parents = stopRows.filter((row) => row.location_type === '1')
  const parentIds = new Set(parents.map((row) => row.stop_id))
  const stationOf = new Map<string, string>()
  for (const row of stopRows) {
    if (parentIds.has(row.stop_id)) stationOf.set(row.stop_id, row.stop_id)
    else if (parentIds.has(row.parent_station)) stationOf.set(row.stop_id, row.parent_station)
  }

  const stationRoutes = new Map<string, Set<string>>()
  for (const row of stopTimeRows) {
    const station = stationOf.get(row.stop_id)
    const route = tripRoute.get(row.trip_id)
    if (station === undefined) throw new Error(`GTFS: stop_times names unknown stop ${row.stop_id}`)
    if (route === undefined) throw new Error(`GTFS: stop_times names unknown trip ${row.trip_id}`)
    const set = stationRoutes.get(station) ?? new Set<string>()
    set.add(route)
    stationRoutes.set(station, set)
  }

  return {
    routes: [...routeIds].sort(byString).map((routeId) => ({
      routeId,
      shortName: routeRows.find((row) => row.route_id === routeId)?.route_short_name ?? routeId,
      shapeIds: [...(routeShapes.get(routeId) ?? [])].sort(byString),
    })),
    shapes,
    stations: [...parents]
      .sort((a, b) => byString(a.stop_id, b.stop_id))
      .map((row) => ({
        stopId: row.stop_id,
        name: row.stop_name,
        location: { lat: row.stop_lat, lng: row.stop_lon },
        routeIds: [...(stationRoutes.get(row.stop_id) ?? [])].sort(byString),
      })),
  }
}
