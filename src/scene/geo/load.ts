/**
 * Downloads the base geo layers (once per URL, again after a failure) before the 3D canvas
 * mounts. The shell starts it at hydration, so the download runs in parallel with the 3D chunk; the body is validated
 * in that chunk (CityCanvas, with schema.ts), so the shell carries no schema code.
 *
 * Never rejects: a failed download and a body that is not JSON are expected outcomes (offline,
 * a bad deploy), reported as a result so nothing throws into React and the scene can fall back
 * without an uncaught error.
 */
export type GeoLoadFailure =
  | { readonly reason: 'geo-network' }
  | { readonly reason: 'geo-http'; readonly status: number }
  | { readonly reason: 'geo-json' }
  | { readonly reason: 'geo-invalid'; readonly paths: readonly string[] }

export type GeoDownload =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly failure: GeoLoadFailure }

/** Downloads in flight or done, by URL (failures are dropped once they settle). */
const requests = new Map<string, Promise<GeoDownload>>()

async function download(url: string): Promise<GeoDownload> {
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    return { ok: false, failure: { reason: 'geo-network' } }
  }
  if (!response.ok) {
    return { ok: false, failure: { reason: 'geo-http', status: response.status } }
  }
  try {
    return { ok: true, body: (await response.json()) as unknown }
  } catch {
    return { ok: false, failure: { reason: 'geo-json' } }
  }
}

/**
 * The download for `url`: one request in flight per URL, and a body that arrived is kept. A
 * failed download is forgotten once it settles, so the next call (travel's Retry, TRV-1) tries
 * the network again; callers waiting on the failed request still get its failure.
 */
export function loadGeoBase(url: string): Promise<GeoDownload> {
  let request = requests.get(url)
  if (request === undefined) {
    const started = download(url)
    request = started
    requests.set(url, started)
    void started.then((result) => {
      if (!result.ok && requests.get(url) === started) requests.delete(url)
    })
  }
  return request
}

let baseUrl: string | null = null

/**
 * Records the base geo URL the page was rendered with (the scene's mount does, whether or not
 * WebGL works), so travel can load the subway and land layers from the same, already-fetched
 * body (src/state/geoSource.ts).
 */
export function registerGeoBaseUrl(url: string): void {
  baseUrl = url
}

/** The base geo URL, or null before the scene's mount has run. */
export function geoBaseUrl(): string | null {
  return baseUrl
}
