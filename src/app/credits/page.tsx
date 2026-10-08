import type { Metadata } from 'next'
import Link from 'next/link'
import { copy, type CopyKey } from '@/lib/copy'
import { modelCredits } from '@/lib/data/models'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/credits'
import { StoredTheme } from '@/components/legal/StoredTheme'
import { uiThemeClock } from '@/lib/theme'

export const metadata: Metadata = { title: copy('credits.title') }

const SECTIONS: readonly { heading: CopyKey; body: readonly CopyKey[] }[] = [
  { heading: 'credits.nyc.heading', body: ['credits.nyc.body', 'credits.nyc.disclaimer'] },
  { heading: 'credits.mta.heading', body: ['credits.mta.body'] },
  { heading: 'credits.osm.heading', body: ['credits.osm.body'] },
  { heading: 'credits.handles.heading', body: ['credits.handles.body'] },
]

const LICENCE_KEYS = {
  'CC0-1.0': 'credits.models.licence.cc0',
  MIT: 'credits.models.licence.mit',
  'project-original': 'credits.models.licence.original',
} as const satisfies Record<(typeof modelCredits)[number]['licence'], CopyKey>

/** Data sources and their required attribution (data/geo/SOURCES.md), linked from the map. */
export default function CreditsPage() {
  return (
    // The shell locks page scroll (globals.css), so this page scrolls inside its own box.
    <div className="h-full overflow-y-auto overscroll-contain">
      <main className="mx-auto max-w-2xl px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <StoredTheme themeColor={uiThemeClock().themeColor} />
        <h1 className="text-2xl font-extrabold tracking-tight text-fg">{copy('credits.title')}</h1>
        <p className="mt-2 text-sm text-muted">{copy('credits.intro')}</p>
        {SECTIONS.map((section) => (
          <section key={section.heading} className="mt-6">
            <h2 className="text-lg font-bold text-fg">{copy(section.heading)}</h2>
            {section.body.map((key) => (
              <p key={key} className="mt-2 text-sm leading-relaxed text-muted">
                {copy(key)}
              </p>
            ))}
          </section>
        ))}
        <section className="mt-6">
          <h2 className="text-lg font-bold text-fg">{copy('credits.models.heading')}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{copy('credits.models.body')}</p>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            {modelCredits.map((pack) => (
              <li key={pack.title}>
                <a
                  href={pack.homepage}
                  rel="noopener noreferrer"
                  target="_blank"
                  className="underline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {copy('credits.models.pack', {
                    title: pack.title,
                    version: pack.version,
                    author: pack.author,
                    licence: copy(LICENCE_KEYS[pack.licence]),
                  })}
                </a>
              </li>
            ))}
          </ul>
        </section>
        <Link
          href="/"
          className="mt-8 inline-flex min-h-11 items-center rounded-lg bg-raised px-4 font-semibold text-taxi-ink focus-visible:outline-2 focus-visible:outline-focus"
        >
          {copy('credits.back')}
        </Link>
      </main>
    </div>
  )
}
