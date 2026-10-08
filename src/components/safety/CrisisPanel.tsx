'use client'

import { copy } from '@/lib/copy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/safety'

/**
 * Crisis resources (S18b, SEC-12 wording pending review), shown in the report form as soon as
 * "Someone might hurt themselves" is picked: reports are not watched in real time, so the
 * player learns where to get help now. Its strings are slang-immune (src/lib/copy/registry.ts).
 * The numbers are text, not links: tel: links are unreliable in an installed web app.
 */
export function CrisisPanel() {
  return (
    <section
      data-crisis-panel=""
      aria-labelledby="crisis-panel-title"
      className="flex flex-col gap-1 rounded-xl border-2 border-taxi bg-canvas p-3"
    >
      <h4 id="crisis-panel-title" className="font-extrabold text-taxi-ink">
        {copy('safety.crisis.title')}
      </h4>
      <p className="text-sm text-fg">{copy('safety.crisis.body')}</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm font-semibold text-fg">
        <li>{copy('safety.crisis.988')}</li>
        <li>{copy('safety.crisis.911')}</li>
        <li>{copy('safety.crisis.outsideUs')}</li>
      </ul>
    </section>
  )
}
