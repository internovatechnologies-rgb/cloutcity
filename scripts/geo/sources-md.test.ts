import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GeoConfigSchema } from '../../src/lib/data/schemas/config'
import { SubwayFileSchema } from '../../src/lib/data/schemas/world'
import { LockSchema } from './lock'
import {
  LION_METADATA_URL,
  MAPPLUTO_DISCLAIMER,
  MTA_ATTRIBUTION,
  NAME_NOT_DOWNLOADED,
  renderSourcesMd,
} from './sources-md'
import { pageFile } from './lock'

const ROOT = join(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const lock = LockSchema.parse(JSON.parse(read('scripts/geo/sources.lock.json')))
const config = GeoConfigSchema.parse(JSON.parse(read('data/config/geo.json')))
const subway = SubwayFileSchema.parse(JSON.parse(read('data/geo/subway.derived.json')))
const sourcesMd = read('data/geo/SOURCES.md')

describe('data/geo/SOURCES.md', () => {
  it('is exactly what the lock, the geo config and the terminal extensions render', () => {
    expect(sourcesMd).toBe(renderSourcesMd(lock, config, subway.terminalExtensions))
  })

  it.each(lock.sources.map((s) => [s.id, s] as const))(
    'records %s: URL, catalogue page, retrieval date, hash and terms',
    (_id, source) => {
      for (const text of [
        source.url,
        source.catalogUrl,
        `Retrieved: ${source.retrieved}`,
        source.sha256,
        source.terms.url,
        source.terms.name,
      ]) {
        expect(sourcesMd).toContain(text)
      }
    },
  )

  it('carries the required attribution and disclaimers', () => {
    expect(sourcesMd).toContain(MTA_ATTRIBUTION)
    expect(MTA_ATTRIBUTION).toMatch(/not endorsed by, licensed by or affiliated with the MTA/)
    expect(MTA_ATTRIBUTION).toMatch(/may not be accurate, complete, timely or real time/)
    expect(sourcesMd).toContain('The City of New York can not vouch for the accuracy')
    expect(sourcesMd).toContain('NYC Department of City Planning')
    expect(sourcesMd).toMatch(/raw zip is kept unmodified in the gitignored cache/)
    expect(sourcesMd).toMatch(/## OpenStreetMap\n\nNot used\./)
    expect(sourcesMd).toContain('SEC-3')
  })

  it('quotes the NYC Open Data disclaimer in full and the MTA hosting terms', () => {
    expect(sourcesMd).toContain(
      'The City of New York can not vouch for the accuracy or completeness of data provided by this web site or application or for the usefulness or integrity of the web site or application. This site provides applications using data that has been modified for use from its original source, NYC.gov, the official web site of the City of New York.',
    )
    expect(sourcesMd).toContain('obtained from an MTA server and stored on our own server')
    expect(sourcesMd).toMatch(/never implies accuracy, completeness or\s+timeliness/)
    expect(sourcesMd).toMatch(/route colours dropped/)
  })

  it('states the ODbL rule for any future OpenStreetMap layer', () => {
    expect(sourcesMd).toContain('ODbL')
    expect(sourcesMd).toContain('© OpenStreetMap')
    expect(sourcesMd).toContain('https://www.openstreetmap.org/copyright')
  })

  it('names every derived output file it documents, and labels them derived', () => {
    for (const path of [
      'geo/land.derived.json',
      'geo/water.derived.json',
      'geo/parks.derived.json',
      'geo/subway.derived.json',
      'zones/zones.derived.json',
      'zones/zone-shapes.derived.json',
    ]) {
      expect(sourcesMd).toContain(`\`${path}\``)
    }
    expect(sourcesMd).toMatch(/derived data: simplified\s+artwork/)
  })

  it.each(lock.pagedSources.map((s) => [s.id, s] as const))(
    'records %s: query, count query and count, retrieval date and every page hash',
    (_id, source) => {
      for (const text of [
        `- Source id: \`${source.id}\``,
        `- Query: <${source.url}>`,
        `- Count query: <${source.countUrl}> (${source.count} features)`,
        source.catalogUrl,
        source.terms.url,
      ]) {
        expect(sourcesMd).toContain(text)
      }
      source.pages.forEach((page, index) => {
        expect(sourcesMd).toContain(
          `\`.cache/geo/${pageFile(source.id, index)}\` (${page.bytes} bytes, sha256 \`${page.sha256}\`)`,
        )
      })
    },
  )

  it('documents the OTI building footprints: item, terms, NAME not downloaded, outputs', () => {
    expect(lock.pagedSources).toHaveLength(config.districts.length)
    expect(sourcesMd).toContain('## NYC Office of Technology and Innovation (NYC Open Data)')
    expect(sourcesMd).toContain(
      'https://www.arcgis.com/home/item.html?id=870bf69e8a8044aea4488e564c0b4010',
    )
    expect(NAME_NOT_DOWNLOADED).toMatch(/^NAME field not downloaded/)
    expect(sourcesMd).toContain('NAME field not downloaded')
    expect(sourcesMd).toContain('`geo/districts/<district>.<tier>.derived.json`')
    expect(sourcesMd).toContain('HEIGHT_ROOF` feet × 0.3048')
    expect(sourcesMd).toMatch(
      /Catalogue page: <https:\/\/data\.cityofnewyork\.us\/d\/5zhs-2jue> \(to re-verify from a US network/,
    )
    expect(sourcesMd).toMatch(
      /Required attribution: data from NYC Open Data, provided by the NYC Office of Technology and\s+Innovation/,
    )
  })

  it('documents MapPLUTO: item, re-verify note, what was downloaded, and the DCP disclaimer', () => {
    expect(sourcesMd).toContain(
      'https://www.arcgis.com/home/item.html?id=1564ace0b4f44318ac39920737f9bd07',
    )
    expect(sourcesMd).toMatch(/dwn-pluto-mappluto\.page> \(to re-verify from a US network/)
    expect(sourcesMd).toContain('`geo/blocks.<tier>.derived.json`')
    expect(sourcesMd).toContain('No lot geometry, address, owner')
    expect(sourcesMd).toContain(`> ${MAPPLUTO_DISCLAIMER}`)
    expect(MAPPLUTO_DISCLAIMER).toMatch(
      /^MapPLUTO is being provided by the Department of City Planning/,
    )
  })

  it('lists every terminal extension', () => {
    for (const ext of subway.terminalExtensions) {
      expect(sourcesMd).toContain(
        `Line \`${ext.lineId}\` extended ${ext.gapM} m to station \`${ext.stationId}\``,
      )
    }
  })

  it('documents the LION queries: the data dictionary, the codes used and the frames file', () => {
    expect(sourcesMd).toContain('### LION street centerlines (landmark frames)')
    expect(sourcesMd).toContain(LION_METADATA_URL)
    expect(sourcesMd).toContain('`landmarks/frames.derived.json`')
    expect(sourcesMd).toMatch(/E entrance\/exit ramp/)
    expect(sourcesMd).toContain('The Department of City Planning make no representation')
  })
})
