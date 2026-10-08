import type { Metadata } from 'next'
import { LegalPage } from '@/components/legal/LegalPage'
import { copy } from '@/lib/copy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/legal'

// TODO(S27): legal review. Placeholder text until a human writes the real Terms.
export const metadata: Metadata = { title: copy('legal.terms.title') }

export default function TermsPage() {
  return (
    <LegalPage
      titleKey="legal.terms.title"
      paragraphKeys={['legal.terms.intro', 'legal.terms.age', 'legal.terms.conduct']}
      links={{ conduct: { href: '/conduct', labelKey: 'legal.terms.conductLink' } }}
    />
  )
}
