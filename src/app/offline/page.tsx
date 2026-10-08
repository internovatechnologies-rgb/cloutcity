import type { Metadata } from 'next'
import { StoredTheme } from '@/components/legal/StoredTheme'
import { copy } from '@/lib/copy'
import { uiThemeClock } from '@/lib/theme'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/offline'

export const metadata: Metadata = { title: copy('offline.title') }

/**
 * What the service worker (S04e) shows for a page navigation that fails offline. Static and
 * precached. The way back is a plain link, not next/link: a full navigation to `/` is served
 * from the precache, where a client-side transition would fetch its payload from the network.
 * It shows the theme the game last showed, like the legal pages (UI-14).
 */
export default function OfflinePage() {
  return (
    // The shell locks page scroll (globals.css), so this page scrolls inside its own box.
    <div className="h-full overflow-y-auto overscroll-contain">
      <main className="mx-auto flex max-w-prose flex-col gap-4 px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <StoredTheme themeColor={uiThemeClock().themeColor} />
        <h1 className="text-3xl font-extrabold tracking-tight text-fg">{copy('offline.title')}</h1>
        <p className="text-fg">{copy('offline.body')}</p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full page load, served from the precache offline */}
        <a
          href="/"
          className="inline-flex min-h-11 items-center self-start rounded-lg bg-raised px-4 font-semibold text-taxi-ink focus-visible:outline-2 focus-visible:outline-focus"
        >
          {copy('offline.back')}
        </a>
      </main>
    </div>
  )
}
