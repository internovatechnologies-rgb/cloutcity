/**
 * scripts/geo/sources.lock.json: the pinned upstream files the geo build reads. The source
 * definitions below are the single source of truth for what is downloaded and from where; the
 * lock adds what was actually retrieved (date, sha256, size), so a changed upstream file fails
 * the build instead of silently changing the map. District building footprints are paged
 * queries built from data/config/geo.json `districts` (buildingSourceDefinitions); their lock
 * entries (`pagedSources`) pin every page and the query's feature count.
 */
import { z } from 'zod'
import type { GeoDistrict } from '../../src/lib/data/schemas/config.ts'
import { METRES_PER_DEG_LAT, METRES_PER_DEG_LNG } from '../../src/lib/geo/projection.ts'
import {
  BUILDING_SOURCE_IDS,
  GEO_SOURCE_IDS,
  LION_SOURCE_IDS,
  LION_STREETS,
  buildingSourceId,
  type GeoSourceId,
} from '../../src/lib/geo/sources.ts'

const httpsUrl = z.url({ protocol: /^https$/ })

const TermsSchema = z.strictObject({ name: z.string().min(1), url: httpsUrl })

const SourceDefinitionSchema = z.strictObject({
  id: z.enum(GEO_SOURCE_IDS),
  title: z.string().min(1),
  publisher: z.string().min(1),
  /** Human-readable catalogue page for the dataset. */
  catalogUrl: httpsUrl,
  /** The exact URL downloaded. */
  url: httpsUrl,
  /** File name in the cache (.cache/geo/). */
  file: z.string().regex(/^[a-z0-9-]+\.(?:geojson|json|zip)$/),
  terms: TermsSchema,
})
export type SourceDefinition = z.infer<typeof SourceDefinitionSchema>

export const LockEntrySchema = SourceDefinitionSchema.extend({
  retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.int().positive(),
})
export type LockEntry = z.infer<typeof LockEntrySchema>

/**
 * A query too big for one response (ArcGIS caps a page at maxRecordCount): downloaded page by
 * page with resultOffset/resultRecordCount, each page cached as `<id>-pNN.geojson`.
 */
const PagedSourceDefinitionSchema = z.strictObject({
  id: z.enum(BUILDING_SOURCE_IDS),
  title: z.string().min(1),
  publisher: z.string().min(1),
  catalogUrl: httpsUrl,
  /** The query, without paging parameters (pageUrl adds them). */
  url: httpsUrl,
  /** The same query with returnCountOnly: the total the pages must add up to. */
  countUrl: httpsUrl,
  pageSize: z.int().positive(),
  terms: TermsSchema,
})
export type PagedSourceDefinition = z.infer<typeof PagedSourceDefinitionSchema>

export const PagedLockEntrySchema = PagedSourceDefinitionSchema.extend({
  retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  /** returnCountOnly at download time; the pages hold exactly this many features. */
  count: z.int().nonnegative(),
  pages: z
    .array(
      z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.int().positive() }),
    )
    .min(1)
    .max(100),
})
export type PagedLockEntry = z.infer<typeof PagedLockEntrySchema>

/**
 * A lock whose source lists may be incomplete or out of order: what `--update` accepts as the
 * previous lock, so adding a source keeps the retrieval dates of the ones already pinned.
 */
export const PartialLockSchema = z.strictObject({
  version: z.literal(1),
  sources: z.array(LockEntrySchema),
  /** One per configured district, in BUILDING_SOURCE_IDS order. */
  pagedSources: z.array(PagedLockEntrySchema),
})

export const LockSchema = PartialLockSchema.refine(
  (lock) =>
    lock.sources.length === GEO_SOURCE_IDS.length &&
    lock.sources.every((entry, index) => entry.id === GEO_SOURCE_IDS[index]),
  { error: `sources must list ${GEO_SOURCE_IDS.join(', ')} in that order` },
).refine(
  (lock) => {
    const order = lock.pagedSources.map((entry) => BUILDING_SOURCE_IDS.indexOf(entry.id))
    return order.every((index, i) => i === 0 || index > (order[i - 1] ?? -1))
  },
  { error: 'pagedSources must be unique and in BUILDING_SOURCE_IDS order' },
)
export type Lock = z.infer<typeof LockSchema>

/** Cache file of one page: `oti-buildings-midtown-p00.geojson`. */
export const pageFile = (id: string, page: number) =>
  `${id}-p${String(page).padStart(2, '0')}.geojson`

export const pageUrl = (definition: PagedSourceDefinition, page: number) =>
  `${definition.url}&resultOffset=${page * definition.pageSize}&resultRecordCount=${definition.pageSize}`

const ARCGIS = 'https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services'
const NYC_OPEN_DATA_TERMS = {
  name: 'NYC Open Data Terms of Use',
  url: 'https://www.nyc.gov/html/data/terms.html',
}

/** NYC OTI's public view of the citywide building footprints. */
const OTI_BUILDINGS = `https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/BUILDING_view/FeatureServer/0/query`
/** Buildings, buildings under construction and cantilevered buildings; no sheds or slivers. */
const BUILDING_WHERE = 'FEATURE_CODE IN (2100,5100,1006) AND Shape__Area>=40'
/** The only attribute requested. NAME and every other field are never downloaded. */
export const BUILDING_OUT_FIELDS = 'HEIGHT_ROOF'
/** The layer's maxRecordCount. */
const BUILDING_PAGE_SIZE = 2000

const query = (params: Readonly<Record<string, string>>) =>
  Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')

/** The district circle's bounding box in WGS84, rounded outwards to 6 decimals. */
function envelope(district: GeoDistrict): string {
  const dLat = district.radiusM / METRES_PER_DEG_LAT
  const dLng = district.radiusM / METRES_PER_DEG_LNG
  const down = (value: number) => Math.floor(value * 1e6) / 1e6
  const up = (value: number) => Math.ceil(value * 1e6) / 1e6
  const { lat, lng } = district.center
  return [down(lng - dLng), down(lat - dLat), up(lng + dLng), up(lat + dLat)].join(',')
}

/** The paged footprint download of one district (`oti-buildings-<id>`). */
export function buildingSourceDefinition(district: GeoDistrict): PagedSourceDefinition {
  const filter = {
    where: BUILDING_WHERE,
    geometry: envelope(district),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
  }
  return PagedSourceDefinitionSchema.parse({
    id: buildingSourceId(district.id),
    title: `Building Footprints (${district.label})`,
    publisher: 'NYC Office of Technology and Innovation (OTI)',
    catalogUrl: 'https://data.cityofnewyork.us/d/5zhs-2jue',
    url: `${OTI_BUILDINGS}?${query({
      ...filter,
      outFields: BUILDING_OUT_FIELDS,
      outSR: '4326',
      geometryPrecision: '6',
      orderByFields: 'OBJECTID',
      f: 'geojson',
    })}`,
    countUrl: `${OTI_BUILDINGS}?${query({ ...filter, returnCountOnly: 'true', f: 'json' })}`,
    pageSize: BUILDING_PAGE_SIZE,
    terms: NYC_OPEN_DATA_TERMS,
  })
}

export const buildingSourceDefinitions = (districts: readonly GeoDistrict[]) =>
  [...districts]
    .sort(
      (a, b) =>
        BUILDING_SOURCE_IDS.indexOf(buildingSourceId(a.id)) -
        BUILDING_SOURCE_IDS.indexOf(buildingSourceId(b.id)),
    )
    .map(buildingSourceDefinition)

/** Per community district: lots, total building and lot area (sq ft), average floors. */
const PLUTO_STATISTICS = JSON.stringify([
  { statisticType: 'count', onStatisticField: 'CD', outStatisticFieldName: 'lots' },
  { statisticType: 'sum', onStatisticField: 'BldgArea', outStatisticFieldName: 'bldgArea' },
  { statisticType: 'sum', onStatisticField: 'LotArea', outStatisticFieldName: 'lotArea' },
  { statisticType: 'avg', onStatisticField: 'NumFloors', outStatisticFieldName: 'avgFloors' },
])

/** ArcGIS item of DCP's LION FeatureServer (the street centerline file, release 26C). */
export const LION_ITEM_ID = 'db6fdacfc5ff44e7a244e2f798d98a7d'
/**
 * Only the fields the frames build reads. Ordered by segment id so the response, and its hash,
 * stay byte-identical between downloads of the same release.
 */
const LION_FIELDS = 'Street,SegmentID,SegmentTyp,RW_TYPE,FeatureTyp'

function lionQueryUrl(street: string): string {
  const query = new URLSearchParams({
    where: `Street='${street}'`,
    outFields: LION_FIELDS,
    outSR: '4326',
    orderByFields: 'SegmentID,OBJECTID',
    f: 'geojson',
  })
  return `${ARCGIS}/LION/FeatureServer/0/query?${query.toString()}`
}

const lionDefinitions = LION_SOURCE_IDS.map((id) => ({
  id,
  title: `LION street centerline: ${LION_STREETS[id]}`,
  publisher: 'NYC Department of City Planning',
  catalogUrl: `https://www.arcgis.com/home/item.html?id=${LION_ITEM_ID}`,
  url: lionQueryUrl(LION_STREETS[id]),
  file: `${id}.geojson`,
  terms: NYC_OPEN_DATA_TERMS,
}))

/** In GEO_SOURCE_IDS order. */
export const SOURCE_DEFINITIONS: readonly SourceDefinition[] = z
  .array(SourceDefinitionSchema)
  .parse([
    {
      id: 'dcp-borough-boundaries',
      title: 'Borough Boundaries (clipped to shoreline)',
      publisher: 'NYC Department of City Planning',
      catalogUrl: 'https://data.cityofnewyork.us/d/gthc-hcne',
      url: `${ARCGIS}/NYC_Borough_Boundary/FeatureServer/0/query?where=1%3D1&outFields=BoroCode,BoroName&outSR=4326&orderByFields=BoroCode&f=geojson`,
      file: 'dcp-borough-boundaries.geojson',
      terms: NYC_OPEN_DATA_TERMS,
    },
    {
      id: 'dcp-nta-2020',
      title: '2020 Neighborhood Tabulation Areas (NTAs)',
      publisher: 'NYC Department of City Planning',
      catalogUrl: 'https://data.cityofnewyork.us/d/9nt8-h7nd',
      url: `${ARCGIS}/NYC_Neighborhood_Tabulation_Areas_2020/FeatureServer/0/query?where=1%3D1&outFields=BoroCode,BoroName,NTA2020,NTAName,NTAType,CDTA2020,CDTAName&outSR=4326&orderByFields=NTA2020&f=geojson`,
      file: 'dcp-nta-2020.geojson',
      terms: NYC_OPEN_DATA_TERMS,
    },
    {
      id: 'mta-gtfs-subway',
      title: 'MTA New York City Transit subway static GTFS',
      publisher: 'Metropolitan Transportation Authority (MTA)',
      catalogUrl: 'https://www.mta.info/developers',
      url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip',
      file: 'mta-gtfs-subway.zip',
      terms: {
        name: 'MTA Developer Terms and Conditions (updated 2024-03-13)',
        url: 'https://www.mta.info/developers/terms-and-conditions',
      },
    },
    {
      id: 'dcp-mappluto-density',
      title: 'MapPLUTO: building density by community district',
      publisher: 'NYC Department of City Planning',
      catalogUrl: 'https://www.nyc.gov/site/planning/data-maps/open-data/dwn-pluto-mappluto.page',
      url: `${ARCGIS}/MAPPLUTO/FeatureServer/0/query?${query({
        where: '1=1',
        outStatistics: PLUTO_STATISTICS,
        groupByFieldsForStatistics: 'CD',
        orderByFields: 'CD',
        f: 'json',
      })}`,
      file: 'dcp-mappluto-density.json',
      terms: NYC_OPEN_DATA_TERMS,
    },
    ...lionDefinitions,
  ] satisfies (SourceDefinition & { id: GeoSourceId })[])
