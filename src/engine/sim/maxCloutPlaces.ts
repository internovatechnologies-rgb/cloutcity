/**
 * Where the max-clout bot (economyBot.ts, `maxClout`) plays: every place it may flex at, best
 * multiplier first, and every club, the one paying the most clout first. The caller passes the
 * places (data/landmarks and data/venues); ties go by id, so the order is stable.
 */
import type { EngineConfig } from '../config'
import { flexPlaceMultiplier } from '../flex'
import type { Place } from '../places'

export function maxCloutPlaces(
  places: readonly Place[],
  config: EngineConfig,
): { readonly flexPlaces: readonly Place[]; readonly clubs: readonly Place[] } {
  const flexPlaces = places
    .map((place) => ({ place, multiplier: flexPlaceMultiplier(place, config) }))
    .filter((entry): entry is { place: Place; multiplier: number } => entry.multiplier !== null)
    .sort((a, b) => b.multiplier - a.multiplier || a.place.id.localeCompare(b.place.id))
    .map((entry) => entry.place)
  const clubGain = (id: string) => config.place.clubs[id]?.cloutGain ?? 0
  const clubs = places
    .filter((place) => 'type' in place && place.type === 'club')
    .sort((a, b) => clubGain(b.id) - clubGain(a.id) || a.id.localeCompare(b.id))
  return { flexPlaces, clubs }
}
