/**
 * Home ids and the lowest-rent rule, shared by the balance schema (schemas/config.ts) and the
 * engine (src/engine/rent.ts) so both agree on which home is the eviction target. No imports:
 * Node loads this file directly from scripts/ through schemas/config.ts.
 */
export const HOME_IDS = ['queens-room', 'brooklyn-1br', 'manhattan-loft'] as const
export type HomeIdLiteral = (typeof HOME_IDS)[number]

/** The home with the lowest weekly rent; on a tie, the first in HOME_IDS. */
export function lowestRentHome(
  rentPerWeek: Readonly<Record<HomeIdLiteral, number>>,
): HomeIdLiteral {
  return HOME_IDS.reduce((lowest, id) => (rentPerWeek[id] < rentPerWeek[lowest] ? id : lowest))
}

/**
 * The borough each home is in (S16): moving into a home needs its borough open to the player
 * (src/engine/home.ts `homeLock`, through the borough rules in src/engine/boroughs.ts). Kept here,
 * beside HOME_IDS, so the engine needs no home content file; S05's data/homes/homes.json places
 * each home on the map in the same borough.
 */
export const HOME_BOROUGHS = {
  'queens-room': 'queens',
  'brooklyn-1br': 'brooklyn',
  'manhattan-loft': 'manhattan',
} as const satisfies Readonly<Record<HomeIdLiteral, string>>
