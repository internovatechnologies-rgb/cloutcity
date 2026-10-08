import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { copy } from '@/lib/copy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/models'
import { MODEL_TIERS, SHOWCASE_TIMES, SHOWCASE_VIEWS } from '@/lib/data/schemas/assets'
import { resolveShowcase } from './resolve'
import { ShowcaseClient } from './ShowcaseClient'

export const metadata: Metadata = {
  title: copy('models.showcase.title'),
  robots: { index: false, follow: false },
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback

/**
 * /dev/models (S04h): the hand-made models in review scenes (avatar lineup, a street vignette,
 * an apartment room, the whole catalog) at a chosen time of day and quality tier, for review
 * screenshots at 390 and 1280. Test builds only (NEXT_PUBLIC_TEST_HOOKS=1, inlined at build
 * time): every other build answers 404. Query: ?view=avatars|street|room|catalog
 * &time=day|golden|night&tier=low|mid|high&chrome=0 (hides the switcher for clean shots).
 */
export default async function ModelShowcasePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (process.env.NEXT_PUBLIC_TEST_HOOKS !== '1') notFound()
  const params = await searchParams
  const view = pick(params.view, SHOWCASE_VIEWS, 'street')
  const time = pick(params.time, SHOWCASE_TIMES, 'golden')
  const tier = pick(params.tier, MODEL_TIERS, 'high')
  const href = (change: Record<string, string>) =>
    `?${new URLSearchParams({ view, time, tier, ...change }).toString()}`
  const rows = [
    { label: copy('models.showcase.views'), key: 'view', current: view, values: SHOWCASE_VIEWS },
    { label: copy('models.showcase.times'), key: 'time', current: time, values: SHOWCASE_TIMES },
    { label: copy('models.showcase.tiers'), key: 'tier', current: tier, values: MODEL_TIERS },
  ] as const

  return (
    <main className="relative h-full w-full">
      <h1 className="sr-only">{copy('models.showcase.title')}</h1>
      <ShowcaseClient
        scene={resolveShowcase(view, time, tier)}
        loading={copy('models.showcase.loading')}
        error={copy('models.showcase.error')}
      />
      {params.chrome !== '0' && (
        <nav className="absolute top-2 left-2 flex flex-col gap-1 rounded-lg glass p-2 text-xs text-fg">
          {rows.map((row) => (
            <div key={row.key} className="flex flex-wrap items-center gap-1">
              <span className="font-semibold">{row.label}</span>
              {row.values.map((value) => (
                <Link
                  key={value}
                  href={href({ [row.key]: value })}
                  aria-current={value === row.current ? 'page' : undefined}
                  className="inline-flex min-h-11 items-center rounded px-2 underline aria-[current=page]:bg-pressed aria-[current=page]:no-underline"
                >
                  {copy(`models.showcase.${row.key}.${value}` as Parameters<typeof copy>[0])}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      )}
    </main>
  )
}
