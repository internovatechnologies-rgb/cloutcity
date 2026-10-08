import { describe, expect, it } from 'vitest'
import {
  bootNamespaces,
  maxShellGzBytes,
  shellGuardFailures,
  type GuardInput,
} from './shell-guard.ts'

const passing: GuardInput = {
  shell: [{ name: 'chunks/shell.js', text: 'copy("tabs.map");' }],
  others: [{ name: 'chunks/sheet.js', text: '{"data-cc-feature":"cc-feature:event-sheet"}' }],
  markers: ['cc-feature:event-sheet'],
  bootKeys: ['tabs.map'],
  featureKeys: ['events.ui.continue'],
  shellGzBytes: 1000,
  maxShellGzBytes: 1000,
}

const withShell = (text: string): GuardInput => ({
  ...passing,
  shell: [{ name: 'chunks/shell.js', text: `copy("tabs.map");${text}` }],
})

describe('shellGuardFailures', () => {
  it('passes a shell with boot copy only, at exactly the size limit', () => {
    expect(shellGuardFailures(passing)).toEqual([])
  })

  it('fails one byte over the limit', () => {
    expect(shellGuardFailures({ ...passing, shellGzBytes: 1001 })).toEqual([
      expect.stringMatching(/1001 bytes gz, over the 1000 allowed/),
    ])
  })

  it('fails on a server-only name in any chunk, lazy ones included (S18b)', () => {
    const lazy = { name: 'chunks/mod.js', text: 'process.env.MODERATOR_EMAILS' }
    expect(shellGuardFailures({ ...passing, others: [...passing.others, lazy] })).toEqual([
      'chunks/mod.js: server-only name MODERATOR_EMAILS',
    ])
    expect(shellGuardFailures(withShell('"SUPABASE_SERVICE_ROLE_KEY"'))).toEqual([
      'chunks/shell.js: server-only name SUPABASE_SERVICE_ROLE_KEY',
    ])
  })

  it('fails on the Supabase anonymous sign-in in the shell (S05)', () => {
    expect(shellGuardFailures(withShell('a.auth.signInAnonymously()'))).toEqual([
      'chunks/shell.js: Supabase auth (signInAnonymously)',
    ])
  })

  it('fails on a feature marker in the shell', () => {
    expect(shellGuardFailures(withShell('"cc-feature:event-sheet"'))).toEqual([
      'chunks/shell.js: feature module cc-feature:event-sheet',
    ])
  })

  it('matches markers whole: one id that prefixes another is neither found nor hidden by it', () => {
    const sheet = { name: 'chunks/sheet.js', text: '"cc-feature:event-sheet"' }
    const input: GuardInput = {
      ...passing,
      markers: ['cc-feature:event', 'cc-feature:event-sheet'],
      others: [sheet, { name: 'chunks/event.js', text: '"cc-feature:event"' }],
    }
    // Only the longer id is in the shell: the shorter one must not be reported for it.
    expect(
      shellGuardFailures({
        ...input,
        shell: [{ name: 'chunks/shell.js', text: 'copy("tabs.map");"cc-feature:event-sheet"' }],
      }),
    ).toEqual(['chunks/shell.js: feature module cc-feature:event-sheet'])
    // The shorter id's chunk is missing: the longer id's chunk must not count as seeing it.
    expect(shellGuardFailures({ ...input, others: [sheet] })).toEqual([
      'cc-feature:event is in no lazy chunk: the scan cannot see that feature',
    ])
  })

  it.each([
    '"events.ui.continue"',
    "'events.ui.continue'",
    'JSON.parse(\'{\\"events.ui.continue\\":1}\')',
  ])('fails on a feature copy key in the shell: %s', (literal) => {
    expect(shellGuardFailures(withShell(literal))).toEqual([
      expect.stringMatching(/feature copy key\(s\), e\.g\. events\.ui\.continue/),
    ])
  })

  it('ignores a key that only appears inside a longer string', () => {
    expect(shellGuardFailures(withShell('"see events.ui.continued"'))).toEqual([])
  })

  it('fails on zod in the shell', () => {
    expect(shellGuardFailures(withShell('class $ZodType{}'))).toEqual([
      'chunks/shell.js: zod ($ZodType)',
    ])
  })

  it('fails on a test hook in any chunk, shell or not', () => {
    const lazy = { name: 'chunks/hook.js', text: 'window.__cloutcityPlaces={}' }
    expect(shellGuardFailures({ ...passing, others: [...passing.others, lazy] })).toEqual([
      'chunks/hook.js: test hook __cloutcityPlaces',
    ])
    expect(shellGuardFailures(withShell('window.__cloutcityTest={}'))).toEqual([
      'chunks/shell.js: test hook __cloutcityTest',
    ])
  })

  it('fails when the scan cannot see boot copy or a feature (positive controls)', () => {
    expect(shellGuardFailures({ ...passing, shell: [{ name: 'a.js', text: '' }] })).toEqual([
      expect.stringMatching(/no boot copy key found/),
    ])
    expect(shellGuardFailures({ ...passing, others: [] })).toEqual([
      expect.stringMatching(/cc-feature:event-sheet is in no lazy chunk/),
    ])
    expect(shellGuardFailures({ ...passing, markers: [] })).toEqual([
      'no cc-feature markers found in src',
    ])
  })
})

describe('limits and boot namespaces', () => {
  it('allows shellJsGzKB minus the headroom, in bytes', () => {
    expect(maxShellGzBytes({ shellJsGzKB: 180, shellHeadroomGzKB: 20 })).toBe(160_000)
    expect(maxShellGzBytes({ shellJsGzKB: 20.0015, shellHeadroomGzKB: 20 })).toBe(2)
  })

  it('rejects a missing headroom or one that leaves no budget', () => {
    expect(() => maxShellGzBytes({ shellJsGzKB: 180 })).toThrow(/shellHeadroomGzKB/)
    expect(() => maxShellGzBytes({ shellJsGzKB: 20, shellHeadroomGzKB: 20 })).toThrow(/no shell/)
  })

  it('reads the boot namespaces from the copy core imports', () => {
    expect(bootNamespaces("import x from 'y'\nimport './ns/app'\nimport './ns/tabs'\n")).toEqual([
      'app',
      'tabs',
    ])
  })
})
