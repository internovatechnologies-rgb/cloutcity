/**
 * GET /geo/fallback: the static stylised map (S04c) the shell shows behind the Places panel when
 * the 3D map is unavailable (no WebGL, a failed load, a lost context). Prerendered at build time
 * (force-static) and requested as /geo/fallback?v=<geoVersion>, like /geo/base.
 */
import { copy } from '@/lib/copy'
import '@/lib/copy/ns/boroughs'
import '@/lib/copy/ns/map'
import { scene } from '@/lib/data/config'
import { geoBounds } from '@/lib/data/content'
import { land, parks } from '@/lib/data/geo'
import { scenePalette } from '@/lib/theme'
import { buildFallbackSvg } from '@/lib/world/fallbackMap'
import { boroughs, placeName } from '@/lib/world/places'
import { placesLayer } from '@/lib/world/placesLayer'
import { boundsToLocal } from '@/scene/camera/limits'

export const dynamic = 'force-static'

export function GET(): Response {
  const names = Object.fromEntries(
    boroughs.map((borough) => [
      borough.id,
      placeName({ id: borough.id, nameKey: borough.nameKey }),
    ]),
  ) as Record<(typeof boroughs)[number]['id'], string>
  const svg = buildFallbackSvg({
    land: land.boroughs,
    parks: parks.parks,
    places: placesLayer,
    bounds: boundsToLocal(geoBounds),
    palette: scenePalette(),
    config: scene,
    names,
    expandingSoon: copy('map.expandingSoon'),
  })
  return new Response(svg, {
    headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
  })
}
