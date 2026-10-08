import { handleCase } from '@/server/moderation/handlers'
import { modRouteDeps } from '@/server/moderation/deps'

// The service-role key and MODERATOR_EMAILS are read at request time on the Node runtime;
// nothing here is ever cached or prerendered.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, ctx: RouteContext<'/api/mod/case/[id]'>) {
  const { id } = await ctx.params
  return handleCase(request, id, modRouteDeps())
}
