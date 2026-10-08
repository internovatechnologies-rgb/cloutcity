/**
 * Large optional chunks the service worker does not precache on install (PERF-7): code a player
 * may never need, which the worker caches at runtime the first time it loads (src/sw/sw.ts
 * `cc-chunks-<revision>`, cache-first). A chunk is optional when its built text contains one of
 * these markers. Shared by the worker route's manifest filter (src/server/pwa/revision.ts) and
 * the budget's positive control (scripts/budget.ts), and never imported by client code: a marker
 * that reached a boot chunk would drop that chunk from the precache (the budget fails then, as
 * the path to playable must stay precached).
 */
export const OPTIONAL_CHUNK_MARKERS = [
  // The model runtime: three's glTF loader with the meshopt decoder (S04h), after the map draws.
  { id: 'model-runtime', marker: 'EXT_meshopt_compression' },
  // The /dev/models showcase (S04h).
  { id: 'model-showcase', marker: 'cc-feature:model-showcase' },
  // The apartment's decor models (src/scene/apartment/decorModels.ts), once the room is up.
  { id: 'apartment-decor-models', marker: 'apartment decor models: ' },
  // The /mod console (S18b): moderators only; /mod itself is never precached.
  { id: 'mod-console', marker: 'data-mod-error' },
  // supabase-js (S18): it only works online (sign-in, cloud saves, profiles, safety), so an
  // offline player gains nothing from having it installed; offline, the session stays local.
  { id: 'supabase-client', marker: 'GoTrueClient' },
] as const

/** The markers an optional chunk's text contains (empty: precache it). */
export function optionalChunkMarkers(text: string): string[] {
  return OPTIONAL_CHUNK_MARKERS.filter(({ marker }) => text.includes(marker)).map(({ id }) => id)
}

/** Whether a URL or build path names a JS chunk (`.../static/chunks/....js`). */
export function isChunkPath(path: string): boolean {
  return /(?:^|\/)static\/chunks\/[^?#]+\.js$/.test(path)
}
