/**
 * GET /geo/districts/<tier>/<id>: one district's building masses for one quality tier (S04d),
 * prerendered at build time for every tier and configured district (force-static, no other
 * params). The scene requests it as /geo/districts/<tier>/<id>?v=<content hash>
 * (src/lib/data/districts.ts), so a rebuilt district changes the URL.
 */
import { districtRouteParams, readDistrictBuildings } from '@/lib/data/districts'

export const dynamic = 'force-static'
export const dynamicParams = false

export function generateStaticParams() {
  return districtRouteParams()
}

export async function GET(
  _request: Request,
  { params }: RouteContext<'/geo/districts/[tier]/[id]'>,
): Promise<Response> {
  const { tier, id } = await params
  const body = await readDistrictBuildings(tier, id)
  return body === null ? new Response(null, { status: 404 }) : Response.json(body)
}
