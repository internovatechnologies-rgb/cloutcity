import type { Metadata } from 'next'
import { ModConsole } from '@/components/mod/ModConsole'
import { copy } from '@/lib/copy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/mod'

// Staff only: never indexed. Access is checked by the /api/mod/* routes on every request.
export const metadata: Metadata = {
  title: copy('mod.title'),
  robots: { index: false, follow: false, nocache: true },
}

/** The moderator console (S18b part 2). Its own route, so none of it ships with `/`. */
export default function ModPage() {
  return <ModConsole />
}
