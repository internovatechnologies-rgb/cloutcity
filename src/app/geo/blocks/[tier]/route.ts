/**
 * GET /geo/blocks/<tier>: the procedural low blocks outside the districts for one quality tier
 * (S04d), prerendered at build time for every tier (force-static, no other params). The scene
 * requests it as /geo/blocks/<tier>?v=<content hash> (src/lib/data/districts.ts).
 */
import { QUALITY_TIERS } from '@/lib/data/schemas/config'
import { readBlocks } from '@/lib/data/districts'

export const dynamic = 'force-static'
export const dynamicParams = false

export function generateStaticParams() {
  return QUALITY_TIERS.map((tier) => ({ tier }))
}

export async function GET(
  _request: Request,
  { params }: RouteContext<'/geo/blocks/[tier]'>,
): Promise<Response> {
  const { tier } = await params
  const body = await readBlocks(tier)
  return body === null ? new Response(null, { status: 404 }) : Response.json(body)
}
