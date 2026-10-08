/**
 * GR-9: a new player starts with at most a few notices, each meaningful (S06). Every surface that
 * interrupts play to tell the player something (a modal dialog, the toast zone's content, a badge
 * asking for attention) tags itself `data-cc-notice="<kind>"`, and every kind is one that
 * data/config/tour.json lists as meaningful. tests/e2e/first-session-notices.spec.ts counts the
 * tagged surfaces a new player actually sees.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import tourJson from '@data/config/tour.json'
import { SRC, rel, sourceFiles } from '@/lib/testing/importGraph'

const NOTICE = /data-cc-notice="([^"]*)"/g

/** Modal dialogs that are not notices, and why. */
const NOT_NOTICES: Readonly<Record<string, string>> = {
  // The 18+ welcome card is the gate in front of the game, shown once before play.
  'src/components/welcome/WelcomeGate.tsx': 'the welcome card',
  // A moderator's message about the player's account (S18b): it exists only after a moderation
  // action against a signed-in account, so a new player never sees it.
  'src/components/safety/AccountNotices.tsx': 'a moderator message about the account',
}

/** Toast-zone mounts that are not notices, and why. */
const NOT_NOTICE_TOASTS: Readonly<Record<string, string>> = {
  // Confirms the player's own block, mute or report (S18b): feedback, not an interruption.
  SafetyToastMount: 'feedback on a safety action the player just took',
}

const components = sourceFiles(SRC).filter((file) => file.endsWith('.tsx'))
const code = new Map(components.map((file) => [rel(file), readFileSync(file, 'utf8')]))

function kindsIn(source: string): string[] {
  return [...source.matchAll(NOTICE)].map((match) => match[1] ?? '')
}

describe('first-session notices (GR-9)', () => {
  it('every tagged notice is a meaningful kind, and each kind has one surface', () => {
    const tagged = [...code.entries()].flatMap(([file, source]) =>
      kindsIn(source).map((kind) => ({ file, kind })),
    )
    for (const { file, kind } of tagged) {
      expect(tourJson.meaningfulNotices, `${file} tags "${kind}"`).toContain(kind)
    }
    expect(tagged.map(({ kind }) => kind).sort()).toEqual([...tourJson.meaningfulNotices].sort())
  })

  it('every modal dialog is a tagged notice or a named exception', () => {
    for (const [file, source] of code) {
      if (!source.includes('aria-modal="true"')) continue
      if (file in NOT_NOTICES) continue
      expect(kindsIn(source), `${file} opens a modal dialog without data-cc-notice`).not.toEqual([])
    }
  })

  it('the toast zone holds only tagged notices', () => {
    const page = code.get('src/app/page.tsx') ?? ''
    const zone = /toast:\s*\(?\s*(<>[\s\S]*?<\/>|<\w+[^>]*\/>)/.exec(page)?.[1]
    expect(zone, 'page.tsx fills the toast zone').toBeDefined()
    const mounts = [...(zone ?? '').matchAll(/<(\w+)/g)].map((match) => match[1] ?? '')
    const kinds = mounts.flatMap((toast) => {
      if (toast in NOT_NOTICE_TOASTS) return []
      // The mount names its island's module: `import('./LevelUpToast')`.
      const mount = [...code.entries()].find(([, source]) =>
        source.includes(`export function ${toast}`),
      )
      const island = /import\('\.\/(\w+)'\)/.exec(mount?.[1] ?? '')?.[1]
      const source = [...code.entries()].find(([file]) => file.endsWith(`/${island ?? ''}.tsx`))
      const tagged = kindsIn(source?.[1] ?? '')
      expect(tagged, `${toast} is a tagged notice or a named exception`).not.toEqual([])
      return tagged
    })
    expect(kinds).toEqual(['level-up'])
  })

  it('the limit leaves room for the tour and two more', () => {
    expect(tourJson.newPlayerNoticeMax).toBe(3)
    expect(tourJson.meaningfulNotices).toContain('tour')
  })
})
