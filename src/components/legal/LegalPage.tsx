import Link from 'next/link'
import { copy, copyParts, type CopyKey } from '@/lib/copy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/legal'
import { StoredTheme } from './StoredTheme'
import { uiThemeClock } from '@/lib/theme'

/** A link a paragraph's `{slot}` placeholder stands for. */
export interface LegalLink {
  readonly href: string
  readonly labelKey: CopyKey
}

export interface LegalSection {
  readonly headingKey: CopyKey
  readonly paragraphKeys?: readonly CopyKey[]
  /** Rendered as a bulleted list after the paragraphs. */
  readonly listKeys?: readonly CopyKey[]
}

interface LegalPageProps {
  readonly titleKey: CopyKey
  readonly paragraphKeys: readonly CopyKey[]
  readonly sections?: readonly LegalSection[]
  /** Links for `{slot}` placeholders in any paragraph or list item, by slot name. */
  readonly links?: Readonly<Record<string, LegalLink>>
}

const LINK_CLASS = 'font-semibold text-taxi-ink underline underline-offset-2'

/** A copy string with its `{slot}` placeholders replaced by links. */
function LinkedText({
  textKey,
  links,
}: {
  readonly textKey: CopyKey
  readonly links: Readonly<Record<string, LegalLink>>
}) {
  return copyParts(textKey).map((part, index) => {
    if (part.kind === 'text') return part.text
    const link = links[part.name]
    if (link === undefined) throw new Error(`No link for {${part.name}} in "${textKey}"`)
    return (
      <Link key={index} href={link.href} className={LINK_CLASS}>
        {copy(link.labelKey)}
      </Link>
    )
  })
}

/**
 * A static legal page (Terms, Privacy, the Code of Conduct). The shell locks page scroll, so the
 * page scrolls inside its own <main>. Not gated by the welcome card: players read these before
 * agreeing.
 */
export function LegalPage({ titleKey, paragraphKeys, sections = [], links = {} }: LegalPageProps) {
  return (
    <main className="h-full overflow-y-auto overscroll-contain px-4 py-8">
      <StoredTheme themeColor={uiThemeClock().themeColor} />
      <article className="mx-auto flex max-w-prose flex-col gap-4">
        <p
          role="note"
          className="rounded-xl border border-taxi px-3 py-2 text-sm font-semibold text-taxi-ink"
        >
          {copy('legal.placeholderNotice')}
        </p>
        <h1 className="text-3xl font-extrabold tracking-tight text-fg">{copy(titleKey)}</h1>
        {paragraphKeys.map((key) => (
          <p key={key} className="text-fg">
            <LinkedText textKey={key} links={links} />
          </p>
        ))}
        {sections.map((section) => (
          <section key={section.headingKey} className="flex flex-col gap-2">
            <h2 className="text-xl font-bold text-fg">{copy(section.headingKey)}</h2>
            {(section.paragraphKeys ?? []).map((key) => (
              <p key={key} className="text-fg">
                <LinkedText textKey={key} links={links} />
              </p>
            ))}
            {section.listKeys === undefined ? null : (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-fg">
                {section.listKeys.map((key) => (
                  <li key={key}>
                    <LinkedText textKey={key} links={links} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
        <Link
          href="/"
          className="flex min-h-11 items-center self-start font-semibold text-taxi-ink underline underline-offset-2"
        >
          {copy('legal.back')}
        </Link>
      </article>
    </main>
  )
}
