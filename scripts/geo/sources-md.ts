/**
 * Renders data/geo/SOURCES.md from the lock plus a fixed legal template, so the record of
 * sources, dates, terms, transformations and attribution can never drift from what the build
 * actually used. Player-facing attribution becomes copy keys later (S04a); the in-app wording
 * here is a proposal.
 */
import { QUALITY_TIERS, type GeoConfig } from '../../src/lib/data/schemas/config.ts'
import { LION_SOURCE_IDS, buildingSourceId } from '../../src/lib/geo/sources.ts'
import {
  BUILDING_OUT_FIELDS,
  pageFile,
  type Lock,
  type LockEntry,
  type PagedLockEntry,
} from './lock.ts'

export interface TerminalExtension {
  readonly lineId: string
  readonly stationId: string
  /** Length of the added segment, whole metres. */
  readonly gapM: number
}

/** Fixed per-source details the lock does not carry. */
const ARCGIS_ITEMS: Readonly<Record<string, string>> = {
  'dcp-borough-boundaries': 'e740addebac54632a5f216fd778af06d',
  'dcp-nta-2020': 'f262ae2935a04f1e83d5e58e0a834785',
  'dcp-mappluto-density': '1564ace0b4f44318ac39920737f9bd07',
}

/** The OTI BUILDING_view layer every district query reads. */
const OTI_BUILDINGS_ITEM = '870bf69e8a8044aea4488e564c0b4010'
const OTI_BUILDINGS_METADATA =
  'https://github.com/CityOfNewYork/nyc-geo-metadata/blob/master/Metadata/Metadata_BuildingFootprints.md'

/** Catalogue pages the build machine could not open (NYC Open Data and nyc.gov return 403). */
const UNVERIFIED_CATALOGUES = new Set(['dcp-mappluto-density'])
const REVERIFY = '(to re-verify from a US network; it refused requests from the build machine)'

/** The licence text DCP attaches to MapPLUTO (ArcGIS item licenseInfo, retrieved with the data). */
export const MAPPLUTO_DISCLAIMER =
  "MapPLUTO is being provided by the Department of City Planning (DCP) on DCP's website for " +
  'informational purposes only. DCP does not warranty the completeness, accuracy, content, or ' +
  'fitness for any particular purpose or use of MapPLUTO, nor are any such warranties to be ' +
  'implied or inferred with respect to MapPLUTO as furnished on the website. DCP and the City ' +
  'are not liable for any deficiencies in the completeness, accuracy, content, or fitness for ' +
  'any particular purpose or use of MapPLUTO, or applications utilizing MapPLUTO, provided by ' +
  'any third party.'

export const NAME_NOT_DOWNLOADED =
  'NAME field not downloaded: the queries request `outFields=HEIGHT_ROOF` only, so no building ' +
  'name or other attribute ever reaches the cache, the derived files or the game.'

const NYC_DISCLAIMER =
  'The City of New York can not vouch for the accuracy or completeness of data provided by this ' +
  'web site or application or for the usefulness or integrity of the web site or application. ' +
  'This site provides applications using data that has been modified for use from its original ' +
  'source, NYC.gov, the official web site of the City of New York.'

export const MTA_ATTRIBUTION =
  'Subway data: MTA New York City Transit static GTFS, obtained from an MTA server and stored on ' +
  'our own server. Lines and stations are simplified artwork derived from it. Clout City is not ' +
  'endorsed by, licensed by or affiliated with the MTA. This data may not be accurate, complete, ' +
  'timely or real time.'

/** DCP's LION metadata: the data dictionary for the SegmentTyp and RW_TYPE codes. */
export const LION_METADATA_URL =
  'https://s-media.nyc.gov/agencies/dcp/assets/files/pdf/data-tools/bytes/lion_metadata.pdf'

const LION_DISCLAIMER =
  'The Department of City Planning make no representation as to the accuracy of the ' +
  'information or its suitability for any purposes. The Department and the City disclaim any ' +
  'liability for errors that may be contained herein.'

function lionSection(lock: Lock): string[] {
  const sources = LION_SOURCE_IDS.map((id) => entry(lock, id))
  return [
    '### LION street centerlines (landmark frames)',
    '',
    'One query per street, each an exact `Street` match on the LION FeatureServer (release 26C),',
    'reduced to the fields used and ordered by segment id so the bytes are stable.',
    '',
    '- Used for: `landmarks/frames.derived.json` (where each landmark model stands and faces).',
    `- Codes (LION data dictionary <${LION_METADATA_URL}>): \`SegmentTyp\` B both, C connector,`,
    '  E entrance/exit ramp, F faux, G generic, R roadbed, T terminator, U undivided, S suppressed;',
    '  `RW_TYPE` 1 street, 3 bridge, 9 ramp. A bridge uses only its main-roadway segment types',
    '  and roadway types (data/landmarks/models.json `frame`), never ramps or connectors.',
    '- Transformations: projected to local metres; bridges: the length-weighted principal axis',
    '  of those segments, its two ends where the extreme vertices project onto it (each checked',
    '  to lie on the land of the borough it spans, from the borough boundaries above), the',
    '  heading from the first spanned borough to the second; other landmarks: the bearing of',
    "  the nearest segment of the fronting street plus the model's face angle. Headings are",
    '  rounded to 0.1°, points to whole metres. No street geometry is kept.',
    `- The item's own notice: "${LION_DISCLAIMER}"`,
    '',
    ...sources.flatMap((source) => [`#### ${source.title}`, '', ...sourceFacts(source), '']),
  ]
}

function entry(lock: Lock, id: string): LockEntry {
  const found = lock.sources.find((source) => source.id === id)
  if (found === undefined) throw new Error(`SOURCES.md: lock has no source ${id}`)
  return found
}

function sourceFacts(source: LockEntry): string[] {
  const item = ARCGIS_ITEMS[source.id]
  return [
    `- Publisher: ${source.publisher}`,
    `- Downloaded from: <${source.url}>`,
    ...(item === undefined
      ? []
      : [`- ArcGIS item: <https://www.arcgis.com/home/item.html?id=${item}>`]),
    `- Catalogue page: <${source.catalogUrl}>${UNVERIFIED_CATALOGUES.has(source.id) ? ` ${REVERIFY}` : ''}`,
    `- Retrieved: ${source.retrieved}`,
    `- File: \`.cache/geo/${source.file}\` (${source.bytes} bytes, sha256 \`${source.sha256}\`)`,
    `- Terms: ${source.terms.name} <${source.terms.url}>`,
  ]
}

function pagedFacts(source: PagedLockEntry, config: GeoConfig): string[] {
  const district = config.districts.find((d) => buildingSourceId(d.id) === source.id)
  const where =
    district === undefined
      ? ''
      : ` (centre ${district.center.lat}, ${district.center.lng}; radius ${district.radiusM} m)`
  return [
    `#### ${source.title}`,
    '',
    `- Source id: \`${source.id}\`${where}`,
    `- Query: <${source.url}>`,
    `- Count query: <${source.countUrl}> (${source.count} features)`,
    `- Retrieved: ${source.retrieved}`,
    `- Pages of ${source.pageSize} (\`resultOffset\`/\`resultRecordCount\`):`,
    ...source.pages.map(
      (page, index) =>
        `  - \`.cache/geo/${pageFile(source.id, index)}\` (${page.bytes} bytes, sha256 \`${page.sha256}\`)`,
    ),
    '',
  ]
}

function buildingsSection(lock: Lock, config: GeoConfig): string[] {
  if (lock.pagedSources.length === 0) return []
  const [first] = lock.pagedSources
  const tiers = config.buildingTiers
  const tierLines = QUALITY_TIERS.map((tier) => {
    const t = tiers.tiers[tier]
    return (
      `  - ${tier}: Douglas-Peucker ${t.simplifyM} m, footprints under ${t.minAreaM2} m² dropped` +
      `${t.minHeightM > 0 ? `, lower than ${t.minHeightM} m dropped` : ''}, heights in ${t.heightBinM} m bins` +
      `${t.merge ? ', touching footprints of one bin merged (holes kept; the area filter applies to the merged mass)' : ', no merging'}`
    )
  })
  return [
    '## NYC Office of Technology and Innovation (NYC Open Data)',
    '',
    '### Building Footprints',
    '',
    `- Publisher: ${first?.publisher ?? ''}`,
    `- Layer: <${first?.url.split('?')[0] ?? ''}> (the public BUILDING_view)`,
    `- ArcGIS item: <https://www.arcgis.com/home/item.html?id=${OTI_BUILDINGS_ITEM}>`,
    `- Catalogue page: <${first?.catalogUrl ?? ''}> ${REVERIFY}`,
    `- Field documentation: <${OTI_BUILDINGS_METADATA}>`,
    `- Terms: ${first?.terms.name ?? ''} <${first?.terms.url ?? ''}>`,
    `- ${NAME_NOT_DOWNLOADED.replace('`outFields=HEIGHT_ROOF`', `\`outFields=${BUILDING_OUT_FIELDS}\``)}`,
    '- Filter: `FEATURE_CODE IN (2100,5100,1006) AND Shape__Area>=40` (buildings, buildings under',
    "  construction, cantilevered buildings; no sheds or slivers), within each district circle's",
    '  bounding box. Pages are kept byte for byte; their total must equal the count query.',
    '- Used for: `geo/districts/<district>.<tier>.derived.json` (building masses per district and',
    '  quality tier).',
    '- Transformations: a footprint is kept when its centroid lies inside the district circle and',
    '  outside every landmark exclusion rectangle in `landmarks/frames.derived.json` (derived in',
    `  the same build); \`HEIGHT_ROOF\` feet × 0.3048, rounded to whole metres (missing or zero: ${tiers.defaultHeightM} m);`,
    `  snapped to ${tiers.quantumM} m; then per tier:`,
    ...tierLines,
    '- Rings are stored relative to the district centre, delta-encoded, with heights as a separate',
    '  column; the files hold numbers only past their header.',
    '',
    'Districts:',
    '',
    ...lock.pagedSources.flatMap((source) => pagedFacts(source, config)),
    'Required attribution: data from NYC Open Data, provided by the NYC Office of Technology and',
    'Innovation, with the NYC Open Data disclaimer quoted under the Department of City Planning.',
    '',
  ]
}

function plutoSection(lock: Lock, config: GeoConfig): string[] {
  const pluto = entry(lock, 'dcp-mappluto-density')
  const blocks = config.blocks
  const angles = Object.entries(blocks.gridAngleDeg)
    .map(([borough, angle]) => `${borough} ${angle}°`)
    .join(', ')
  return [
    `### ${pluto.title}`,
    '',
    ...sourceFacts(pluto),
    '- Downloaded: per community district (`CD`), the lot count, the sums of `BldgArea` and',
    '  `LotArea` and the mean `NumFloors` (ArcGIS `outStatistics`). No lot geometry, address, owner',
    '  or other lot attribute is downloaded.',
    '- Used for: `geo/blocks.<tier>.derived.json` (procedural low blocks outside the districts).',
    '- Transformations: `CD` mapped to its CDTA zone (borough digit to MN/BX/BK/QN/SI); joint',
    '  interest areas skipped; floor-area ratio = building area ÷ lot area. Blocks sit on a',
    `  jittered grid per tier (spacing ${QUALITY_TIERS.map((t) => `${t} ${blocks.spacingM[t]} m`).join(', ')}; jitter ${blocks.jitter} of the spacing)`,
    `  rotated per borough (${angles}), seeded with \`src/engine/rng.ts\` (seed ${blocks.seed}). A point`,
    `  gets a block with chance min(1, FAR ÷ ${blocks.fullFar}), ${blocks.floorM} m per floor around the district's`,
    `  mean floors (±${Math.round(blocks.heightJitter * 100)}%). Points in a district circle, a park or cemetery, a joint`,
    '  interest area or the water get none, nor does a block that would touch a landmark exclusion',
    '  rectangle.',
    '',
    'Required attribution: data from NYC Open Data, provided by the NYC Department of City',
    'Planning (MapPLUTO). DCP disclaimer:',
    '',
    `> ${MAPPLUTO_DISCLAIMER}`,
    '',
  ]
}

export function renderSourcesMd(
  lock: Lock,
  config: GeoConfig,
  terminalExtensions: readonly TerminalExtension[],
): string {
  const boroughs = entry(lock, 'dcp-borough-boundaries')
  const ntas = entry(lock, 'dcp-nta-2020')
  const mta = entry(lock, 'mta-gtfs-subway')
  const extensions =
    terminalExtensions.length === 0
      ? ['- None.']
      : terminalExtensions.map(
          (ext) =>
            `- Line \`${ext.lineId}\` extended ${ext.gapM} m to station \`${ext.stationId}\``,
        )

  const lines = [
    '# Geo data sources',
    '',
    'Generated by `npm run geo:build` from `scripts/geo/sources.lock.json`. Do not edit by hand.',
    '',
    'Every `*.derived.json` file in `data/geo` (including `data/geo/districts`) and `data/zones` is derived data: simplified',
    'artwork built from the sources below, not the original data. Each file says so in its',
    '`derived` and `notice` fields. The raw downloads are kept unmodified in the gitignored cache',
    '(`.cache/geo/`) and re-verified against the sha256 below on every build.',
    '',
    'Common transformations: coordinates projected to local metres (projection `cc-enu-v1`,',
    `origin 40.7, -73.98; \`src/lib/geo/projection.ts\`), rounded to ${config.quantumM} m and delta-encoded.`,
    'Parameters live in `data/config/geo.json`.',
    '',
    '## NYC Department of City Planning (NYC Open Data)',
    '',
    `### ${boroughs.title}`,
    '',
    ...sourceFacts(boroughs),
    '- Used for: `geo/land.derived.json` (borough land) and `geo/water.derived.json` (the sea is',
    '  everything that is not land).',
    `- Transformations: shared-arc topology, Visvalingam simplification (${config.landMinWeightM2} m²),`,
    `  rings smaller than ${config.landMinRingAreaM2} m² dropped, outer rings counter-clockwise.`,
    '',
    `### ${ntas.title}`,
    '',
    ...sourceFacts(ntas),
    '- Used for: `zones/zones.derived.json` and `zones/zone-shapes.derived.json` (one play zone',
    '  per 2020 Community District Tabulation Area: NTAs merged by CDTA code), and',
    '  `geo/parks.derived.json` (NTAs of type 9, park, and 7, cemetery; no names kept).',
    `- Transformations: shared-arc topology, Visvalingam simplification (${config.zoneMinWeightM2} m²),`,
    `  NTAs merged per CDTA, rings smaller than ${config.zoneMinRingAreaM2} m² (zones) or ${config.parkMinRingAreaM2} m²`,
    '  (parks) dropped, zone names taken from the CDTA name without its code and CD/JIA suffix.',
    '',
    ...plutoSection(lock, config),
    'Required attribution: data from NYC Open Data, provided by the NYC Department of City',
    'Planning. NYC Open Data disclaimer (to re-verify from a US network before launch; nyc.gov',
    'refused requests from the build machine):',
    '',
    `> ${NYC_DISCLAIMER}`,
    '',
    ...buildingsSection(lock, config),
    ...lionSection(lock),
    '## MTA',
    '',
    `### ${mta.title}`,
    '',
    ...sourceFacts(mta),
    '- The raw zip is kept unmodified in the gitignored cache; it is read in memory and never',
    '  extracted to disk.',
    '- Used for: `geo/subway.derived.json` (lines and stations).',
    `- Transformations: shapes projected to metres, Douglas-Peucker simplification`,
    `  (${config.subwayToleranceM} m), shapes dropped when they repeat a kept path within ${config.subwayDedupCoverM} m,`,
    '  rounded to whole metres; stations are GTFS parent stations with the lines whose trips stop',
    '  there; route colours dropped (no MTA line bullets or colours are used).',
    `- Terminal extensions (a route's shapes end more than ${config.stationOnLineToleranceM} m short of a station it serves; at most ${config.terminalGapMaxM} m):`,
    ...extensions,
    '',
    'MTA terms: the data is hosted on our own server, never implies accuracy, completeness or',
    'timeliness, and never implies MTA endorsement or licensing.',
    '',
    'Proposed in-app attribution (becomes copy keys in S04a):',
    '',
    `> ${MTA_ATTRIBUTION}`,
    '',
    'SEC-3: whether simplified artwork counts as modifying the data needs a legal ruling before',
    'launch.',
    '',
    '## OpenStreetMap',
    '',
    'Not used. If ever added: its own file under the ODbL, credited "© OpenStreetMap',
    'contributors" linked to <https://www.openstreetmap.org/copyright>, and downloadable from',
    '/credits.',
    '',
  ]
  return lines.join('\n')
}
