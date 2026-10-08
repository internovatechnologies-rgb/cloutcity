/**
 * Ids of the upstream geo sources (scripts/geo/sources.lock.json). Every derived file in
 * /data/geo, /data/zones and /data/landmarks names the sources it was built from.
 *
 * No imports, so Node can load it from scripts/ with its built-in type stripping.
 */

/**
 * NYC DCP LION street centerline queries, one per street a landmark model is oriented by
 * (data/landmarks/models.json `frame.street`). Each is an exact `Street` match, pinned by
 * sha256 like every other source. Sorted by id.
 */
export const LION_STREETS = {
  'dcp-lion-5-avenue': '5 AVENUE',
  'dcp-lion-8-avenue': '8 AVENUE',
  'dcp-lion-brooklyn-bridge': 'BROOKLYN BRIDGE',
  'dcp-lion-city-hall-park-greenway': 'CITY HALL PARK GREENWAY',
  'dcp-lion-ed-koch-queensboro-bridge': 'ED KOCH QUEENSBORO BRIDGE',
  'dcp-lion-ferry-terminal-viaduct': 'FERRY TERMINAL VIADUCT',
  'dcp-lion-joralemon-street': 'JORALEMON STREET',
  'dcp-lion-lexington-avenue': 'LEXINGTON AVENUE',
  'dcp-lion-manhattan-bridge': 'MANHATTAN BRIDGE',
  'dcp-lion-queens-boulevard': 'QUEENS BOULEVARD',
  'dcp-lion-sutphin-boulevard': 'SUTPHIN BOULEVARD',
  'dcp-lion-vanderbilt-avenue': 'VANDERBILT AVENUE',
} as const
export type LionSourceId = keyof typeof LION_STREETS
export type LionStreet = (typeof LION_STREETS)[LionSourceId]

export const LION_SOURCE_IDS = Object.keys(LION_STREETS) as [LionSourceId, ...LionSourceId[]]
export const LION_STREET_NAMES = Object.values(LION_STREETS) as [LionStreet, ...LionStreet[]]

/** The LION source id that holds a street. */
export function lionSourceId(street: LionStreet): LionSourceId {
  const id = LION_SOURCE_IDS.find((key) => LION_STREETS[key] === street)
  if (id === undefined) throw new Error(`No LION source for street ${street}`)
  return id
}

/** Single-file downloads, in lock order. */
export const GEO_SOURCE_IDS = [
  'dcp-borough-boundaries',
  'dcp-nta-2020',
  'mta-gtfs-subway',
  'dcp-mappluto-density',
  ...LION_SOURCE_IDS,
] as const
export type GeoSourceId = (typeof GEO_SOURCE_IDS)[number]

/** Districts that get real building masses (S04d); data/config/geo.json `districts` lists them. */
export const BUILDING_DISTRICT_IDS = [
  'midtown',
  'lower-manhattan',
  'downtown-brooklyn-dumbo',
  'williamsburg',
  'long-island-city',
  'astoria',
  'flushing',
  'jamaica',
] as const
export type BuildingDistrictId = (typeof BUILDING_DISTRICT_IDS)[number]

/**
 * Paged building-footprint downloads, one per district (`oti-buildings-<district id>`), in
 * BUILDING_DISTRICT_IDS order.
 */
export const BUILDING_SOURCE_IDS = [
  'oti-buildings-midtown',
  'oti-buildings-lower-manhattan',
  'oti-buildings-downtown-brooklyn-dumbo',
  'oti-buildings-williamsburg',
  'oti-buildings-long-island-city',
  'oti-buildings-astoria',
  'oti-buildings-flushing',
  'oti-buildings-jamaica',
] as const
export type BuildingSourceId = (typeof BUILDING_SOURCE_IDS)[number]

export const buildingSourceId = (district: BuildingDistrictId): BuildingSourceId =>
  `oti-buildings-${district}`

/** Every id a derived file may name in its `sources`. */
export const DERIVED_SOURCE_IDS = [...GEO_SOURCE_IDS, ...BUILDING_SOURCE_IDS] as const
export type DerivedSourceId = (typeof DERIVED_SOURCE_IDS)[number]
