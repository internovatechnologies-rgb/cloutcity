/**
 * The geo layers travel needs (S08 part 2): the subway and the borough land, taken from the base
 * geo body the 3D map downloads (GET /geo/base, src/scene/geo/load.ts). The download is shared
 * and cached per URL, so on a device with WebGL this costs no extra request; without WebGL it is
 * the one download travel makes. Each layer is validated with the scene's zod/mini schemas
 * before the transit engine sees it (fail fast: a bad body never reaches the graph builder).
 *
 * Never rejects: a missing URL, a failed download and an invalid body are expected outcomes
 * (offline, a bad deploy), reported as a result so the place sheet can fall back to a taxi
 * estimate with a Retry.
 */
import type { LandData } from '@/engine/transit/land'
import type { SubwayData } from '@/engine/transit/network'
import { geoBaseUrl, loadGeoBase, type GeoLoadFailure } from '@/scene/geo/load'
import { LandMiniSchema, SubwayMiniSchema } from '@/scene/geo/schema'

export type TransitGeoFailure = GeoLoadFailure | { readonly reason: 'geo-no-url' }

export type TransitGeo =
  | { readonly ok: true; readonly subway: SubwayData; readonly land: LandData }
  | { readonly ok: false; readonly failure: TransitGeoFailure }

const issuePaths = (issues: readonly { readonly path: readonly PropertyKey[] }[]) =>
  issues.slice(0, 3).map((issue) => issue.path.map(String).join('.') || '(root)')

/** Loads and validates the subway and land layers. `load` is injectable for tests. */
export async function loadTransitGeo(
  load: typeof loadGeoBase = loadGeoBase,
  url: string | null = geoBaseUrl(),
): Promise<TransitGeo> {
  if (url === null) return { ok: false, failure: { reason: 'geo-no-url' } }
  const download = await load(url)
  if (!download.ok) return download
  const body =
    typeof download.body === 'object' && download.body !== null
      ? (download.body as Record<string, unknown>)
      : {}
  const subway = SubwayMiniSchema.safeParse(body.subway)
  const land = LandMiniSchema.safeParse(body.land)
  if (!subway.success || !land.success) {
    const paths = [
      ...(subway.success ? [] : issuePaths(subway.error.issues).map((path) => `subway.${path}`)),
      ...(land.success ? [] : issuePaths(land.error.issues).map((path) => `land.${path}`)),
    ]
    return { ok: false, failure: { reason: 'geo-invalid', paths } }
  }
  return { ok: true, subway: subway.data, land: land.data }
}
