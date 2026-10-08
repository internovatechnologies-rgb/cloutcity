/**
 * Places on the map (venues and landmarks, one id space) for the scene, the Places panel and
 * travel: projected positions, borough gating and accessible names that say why a place is
 * locked (CLAUDE.md "Accessibility").
 *
 * Client code: it reads data/venues, data/landmarks and data/boroughs directly rather than
 * through the classic-zod loader in src/lib/data/content.ts (shell JS budget, see
 * src/lib/client-imports.test.ts). The files are bundled at build time, not user input, and
 * their schemas run in src/lib/data/data.test.ts, which gates every build; that is why the
 * JSON is typed with a cast here instead of parsed.
 */
import boroughsJson from '@data/boroughs/boroughs.json'
import landmarksJson from '@data/landmarks/landmarks.json'
import venuesJson from '@data/venues/venues.json'
import { boroughAccess, placeBoroughAccess, type BoroughAccess } from '@/engine/boroughs'
import { levelClout, type CloutPlayer } from '@/engine/clout'
import { engineConfig, type EngineConfig } from '@/engine/config'
import { copy as activeCopy, isCopyKey, type CopyFn, type CopyKey } from '@/lib/copy'
import type { BoroughsFile } from '@/lib/data/schemas/world'
import type { Borough, Landmark, Venue } from '@/lib/data/schemas/content'
import { cloutLevelName } from '@/lib/economyCopy'
import { project } from '@/lib/geo/projection'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/boroughs'
import '@/lib/copy/ns/landmarks'
import '@/lib/copy/ns/places'
import '@/lib/copy/ns/venues'

export const venues = venuesJson.venues as readonly Venue[]
export const landmarks = landmarksJson.landmarks as readonly Landmark[]
export const boroughs = boroughsJson.boroughs as BoroughsFile['boroughs']

export interface MapPlace {
  readonly id: string
  readonly kind: 'venue' | 'landmark'
  /** A venue's `type` or a landmark's `category`. */
  readonly category: Venue['type'] | Landmark['category']
  /** The borough that gates the place (a bridge's or island's approach borough). */
  readonly borough: Borough
  readonly zoneId: string
  /** Local metres (src/lib/geo/projection.ts) of the place itself, where its pin sits. */
  readonly x: number
  readonly y: number
  /** Local metres of the point travel routes to: `approach ?? location`. */
  readonly routeX: number
  readonly routeY: number
  readonly nameKey: string
}

function toMapPlace(place: Venue | Landmark): MapPlace {
  const isLandmark = 'category' in place
  const pin = project(place.location)
  const route = isLandmark && place.approach !== undefined ? project(place.approach) : pin
  return {
    id: place.id,
    kind: isLandmark ? 'landmark' : 'venue',
    category: isLandmark ? place.category : place.type,
    borough: place.borough,
    zoneId: place.zoneId,
    x: pin.x,
    y: pin.y,
    routeX: route.x,
    routeY: route.y,
    nameKey: place.nameKey,
  }
}

const allPlaces: readonly MapPlace[] = [...venues, ...landmarks].map(toMapPlace)

/** Every venue and landmark, venues first, in data order. */
export function mapPlaces(): readonly MapPlace[] {
  return allPlaces
}

function borough(id: Borough) {
  const entry = boroughs.find((candidate) => candidate.id === id)
  if (entry === undefined) throw new Error(`data/boroughs/boroughs.json has no borough "${id}"`)
  return entry
}

export interface BoroughRenderState {
  /** `dimmed` is "expanding soon" land: drawn, not playable. */
  readonly state: 'normal' | 'dimmed'
  /** Landmarks shown as teaser pins on dimmed land. */
  readonly teaserLandmarkIds: readonly string[]
  /** Copy key of the "expanding soon" label, on dimmed land only. */
  readonly teaserKey?: string
}

/** How the scene draws a borough. Locked (clout-gated) boroughs draw normally. */
export function boroughRenderState(
  id: Borough,
  config: EngineConfig = engineConfig,
): BoroughRenderState {
  const entry = borough(id)
  if (config.boroughs[id].access !== 'expanding-soon') {
    return { state: 'normal', teaserLandmarkIds: [] }
  }
  return entry.teaserKey === undefined
    ? { state: 'dimmed', teaserLandmarkIds: entry.teaserLandmarkIds }
    : { state: 'dimmed', teaserLandmarkIds: entry.teaserLandmarkIds, teaserKey: entry.teaserKey }
}

/**
 * The clout a player's place and borough gates are judged on: `levelClout`, exactly what the
 * engine's own gates read (trips, place actions, shops), so the Places panel never shows a place
 * open that the engine would refuse (Icon needs earned clout, so grants and premium alone never
 * open an Icon-gated borough).
 */
export function gateClout(player: CloutPlayer, config: EngineConfig = engineConfig): number {
  return levelClout(player, config)
}

/**
 * Whether a player with `clout` may go to `place`: gated by its borough, except a memorial, which
 * is open to everyone (DEC-46).
 */
export function placeAccess(
  place: Pick<MapPlace, 'id' | 'borough'>,
  clout: number,
  config: EngineConfig = engineConfig,
): BoroughAccess {
  return placeBoroughAccess(place.id, place.borough, clout, config)
}

/** Whether a player with `clout` may enter `borough` (the Places panel's borough headings). */
export function boroughAccessFor(
  borough: Borough,
  clout: number,
  config: EngineConfig = engineConfig,
): BoroughAccess {
  return boroughAccess(borough, clout, config)
}

function requireKey(key: string | undefined, what: string): CopyKey {
  if (key === undefined || !isCopyKey(key)) throw new Error(`No copy key "${key}" for ${what}`)
  return key
}

export interface PlaceCopyOptions {
  readonly copy?: CopyFn
}

/** A place's display name. */
export function placeName(
  place: Pick<MapPlace, 'id' | 'nameKey'>,
  { copy = activeCopy }: PlaceCopyOptions = {},
): string {
  return copy(requireKey(place.nameKey, `place ${place.id}`))
}

/**
 * Why a borough is closed to the player, in voice, or null when it is open: the borough's
 * why-locked copy (with the required and current level names) or its "expanding soon" teaser.
 */
export function boroughClosedReason(
  id: Borough,
  access: BoroughAccess,
  options: PlaceCopyOptions = {},
): string | null {
  const { copy = activeCopy } = options
  const entry = borough(id)
  switch (access.status) {
    case 'open':
      return null
    case 'locked':
      return copy(requireKey(entry.lockedKey, `locked borough ${id}`), {
        level: cloutLevelName(access.required, options),
        current: cloutLevelName(access.current, options),
      })
    case 'expanding-soon':
      return copy(requireKey(entry.teaserKey, `expanding-soon borough ${id}`))
  }
}

/** True when the place with `id` is a memorial (judged on the engine's own place data). */
export function isMemorial(id: string, config: EngineConfig = engineConfig): boolean {
  return config.places.get(id) === 'memorial'
}

/**
 * The accessible name of a place control: its name, plus why it is closed when it is
 * ("Brooklyn Bridge. Brooklyn is locked: ..."), so a locked place explains itself.
 */
export function placeAccessibleName(
  place: Pick<MapPlace, 'id' | 'nameKey' | 'borough'>,
  access: BoroughAccess,
  options: PlaceCopyOptions = {},
): string {
  const { copy = activeCopy } = options
  const name = placeName(place, options)
  // No lock or level copy ever attaches to a memorial (DEC-46), whatever access is passed.
  if (isMemorial(place.id)) return name
  const reason = boroughClosedReason(place.borough, access, options)
  return reason === null ? name : copy('places.locked.label', { place: name, reason })
}

const placesById: ReadonlyMap<string, Venue | Landmark> = new Map(
  [...venues, ...landmarks].map((place) => [place.id, place]),
)

/** The venue or landmark with `id`, or undefined when there is none. */
export function findPlace(id: string): Venue | Landmark | undefined {
  return placesById.get(id)
}
