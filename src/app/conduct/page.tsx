import type { Metadata } from 'next'
import { LegalPage } from '@/components/legal/LegalPage'
import { copy } from '@/lib/copy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/legal'

// TODO(S27): legal review. Placeholder text until a human reviews the Code of Conduct, the
// sanction ladder and the crisis lines (SEC-12).
export const metadata: Metadata = { title: copy('legal.conduct.title') }

/** The public Code of Conduct (S18b), linked from Terms, the report form and the Me panel. */
export default function ConductPage() {
  return (
    <LegalPage
      titleKey="legal.conduct.title"
      paragraphKeys={['legal.conduct.intro']}
      sections={[
        {
          headingKey: 'legal.conduct.adults.heading',
          paragraphKeys: ['legal.conduct.adults.body'],
        },
        {
          headingKey: 'legal.conduct.respect.heading',
          paragraphKeys: ['legal.conduct.respect.body'],
        },
        {
          headingKey: 'legal.conduct.notAllowed.heading',
          listKeys: [
            'legal.conduct.notAllowed.harassment',
            'legal.conduct.notAllowed.hate',
            'legal.conduct.notAllowed.sexual',
            'legal.conduct.notAllowed.personal',
            'legal.conduct.notAllowed.scams',
            'legal.conduct.notAllowed.impersonation',
            'legal.conduct.notAllowed.cheating',
          ],
        },
        {
          headingKey: 'legal.conduct.tools.heading',
          listKeys: [
            'legal.conduct.tools.block',
            'legal.conduct.tools.mute',
            'legal.conduct.tools.report',
          ],
          paragraphKeys: ['legal.conduct.tools.where'],
        },
        {
          headingKey: 'legal.conduct.sanctions.heading',
          paragraphKeys: ['legal.conduct.sanctions.body', 'legal.conduct.sanctions.hidden'],
        },
        {
          headingKey: 'legal.conduct.appeals.heading',
          paragraphKeys: ['legal.conduct.appeals.body'],
        },
        {
          headingKey: 'legal.conduct.crisis.heading',
          paragraphKeys: ['legal.conduct.crisis.body'],
          listKeys: [
            'legal.conduct.crisis.988',
            'legal.conduct.crisis.911',
            'legal.conduct.crisis.outsideUs',
          ],
        },
      ]}
    />
  )
}
