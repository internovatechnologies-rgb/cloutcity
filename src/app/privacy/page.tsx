import type { Metadata } from 'next'
import { LegalPage } from '@/components/legal/LegalPage'
import { copy } from '@/lib/copy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/legal'

// TODO(S27): legal review. Placeholder text until a human writes the real Privacy Policy.
export const metadata: Metadata = { title: copy('legal.privacy.title') }

export default function PrivacyPage() {
  return (
    <LegalPage
      titleKey="legal.privacy.title"
      paragraphKeys={['legal.privacy.intro', 'legal.privacy.stored', 'legal.privacy.birthYear']}
    />
  )
}
