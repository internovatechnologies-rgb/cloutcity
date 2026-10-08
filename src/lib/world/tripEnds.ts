/**
 * The two ends of a trip (S08 part 2) as travel needs them: the point routes start and end at,
 * the borough that gates it, and where the avatar stands at rest (a place's pin, or the home).
 * A landmark with an `approach` (a bridge, an island) routes to the approach and rests at its
 * pin; everywhere else the two are the same point.
 *
 * Client code: like places.ts it reads data/homes/homes.json directly (it is bundled at build
 * time and validated by HomesFileSchema in src/lib/data/data.test.ts).
 */
import homesJson from '@data/homes/homes.json'
import type { HomeId } from '@/engine/config'
import type { PlayerLocation } from '@/engine/game'
import type { TripStop } from '@/engine/transit/trip'
import type { Borough } from '@/lib/data/schemas/content'
import { project, type LocalPoint } from '@/lib/geo/projection'
import { mapPlaces } from './places'

export interface TripEnd {
  readonly stop: TripStop
  /** Where the avatar stands at this end. */
  readonly rest: LocalPoint
}

const homes = homesJson.homes as Readonly<
  Record<HomeId, { readonly borough: Borough; readonly location: { lat: number; lng: number } }>
>

/** The trip end for a location, or undefined for a place id the data does not have. */
export function tripEnd(location: PlayerLocation, home: HomeId): TripEnd | undefined {
  if (location.kind === 'home') {
    const entry = homes[home]
    const point = project(entry.location)
    return { stop: { location, point, borough: entry.borough }, rest: point }
  }
  const place = mapPlaces().find((candidate) => candidate.id === location.placeId)
  if (place === undefined) return undefined
  return {
    stop: { location, point: { x: place.routeX, y: place.routeY }, borough: place.borough },
    rest: { x: place.x, y: place.y },
  }
}
