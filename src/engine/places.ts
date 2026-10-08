/**
 * Rules for places (venues and landmarks share one id space): opening hours on the personal
 * game clock, and which hooks a place allows. Memorials are look-only: they allow nothing, so
 * no flex, clout, emote, event or crime can ever target one (CLAUDE.md "Map and landmarks").
 * Government buildings never host crime.
 */
import type { Hours, Landmark, Venue } from '@/lib/data/schemas/content'

export type Place = Venue | Landmark

/** What another system may do at a place. `crime` is for crime-tagged events. */
export type PlaceHook = 'visit' | 'flex' | 'emote' | 'events' | 'crime'

const MINUTES_PER_DAY = 24 * 60

/** Minutes after midnight of an `HH:MM` clock time. */
export function minuteOf(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number)
  if (hours === undefined || minutes === undefined || Number.isNaN(hours + minutes)) {
    throw new Error(`Invalid clock time "${clock}"`)
  }
  return hours * 60 + minutes
}

/**
 * True when a place with `hours` is open at `minuteOfDay` (0..1439). Open from the opening
 * minute, closed from the closing minute; a close earlier than the open runs past midnight.
 */
export function isOpenAt(hours: Hours, minuteOfDay: number): boolean {
  if (hours === '24h') return true
  const minute = ((Math.floor(minuteOfDay) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const open = minuteOf(hours.open)
  const close = minuteOf(hours.close)
  return open < close ? minute >= open && minute < close : minute >= open || minute < close
}

function isLandmark(place: Place): place is Landmark {
  return 'category' in place
}

/**
 * Whether `hook` may target `place`. A landmark allows the interactions it lists (crime: any
 * landmark but a government building); memorials allow nothing. Venues are invented
 * businesses and allow every hook.
 */
export function placeAllows(place: Place, hook: PlaceHook): boolean {
  if (!isLandmark(place)) return true
  if (place.category === 'memorial') return false
  if (hook === 'crime') return place.category !== 'government'
  return place.interactions.includes(hook)
}
