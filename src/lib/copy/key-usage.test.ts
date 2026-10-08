/**
 * Every module that names a copy key can render it (S05c): the key is in a boot namespace, or
 * the module's static import closure includes that namespace's module (src/lib/copy/ns/<ns>.ts).
 * Without this, a missing import would only show up as CopyNamespaceNotLoadedError when a player
 * reaches the screen. Keys named by content data are checked in src/lib/data/data.test.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SRC,
  rel,
  resolveLocal,
  sourceFiles,
  staticClosure,
  staticSpecifiers,
} from '@/lib/testing/importGraph'
import { BOOT_NAMESPACES } from './index'
import { baseCopy } from './all'

const KEYS = new Set(Object.keys(baseCopy.strings))
const NAMESPACES = new Set([...KEYS].map((key) => key.slice(0, key.indexOf('.'))))

const QUOTED_KEY = /['"`]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)['"`]/g
// A key built in a template literal: `place.actions.${id}.name`.
const TEMPLATE_KEY = /`([a-z][a-zA-Z0-9]*)\.[^`]*\$\{/g

/** Namespaces a source file names keys from, literally or as a template prefix. */
function namespacesUsed(code: string): Set<string> {
  const used = new Set<string>()
  for (const match of code.matchAll(QUOTED_KEY)) {
    const key = match[1] ?? ''
    if (KEYS.has(key)) used.add(key.slice(0, key.indexOf('.')))
  }
  for (const match of code.matchAll(TEMPLATE_KEY)) {
    const ns = match[1] ?? ''
    if (NAMESPACES.has(ns)) used.add(ns)
  }
  return used
}

const NS_MODULE = /^src\/lib\/copy\/ns\/(\w+)\.ts$/

function namespacesLoaded(file: string): Set<string> {
  const loaded = new Set<string>(BOOT_NAMESPACES)
  for (const reached of staticClosure([file]).files) {
    const path = rel(reached)
    if (path === 'src/lib/copy/all.ts') return new Set(NAMESPACES)
    const ns = NS_MODULE.exec(path)?.[1]
    if (ns !== undefined) loaded.add(ns)
  }
  return loaded
}

describe('copy key usage (S05c)', () => {
  // Modules that render copy: a runtime import of the copy core. Others (the engine) may name
  // config paths that look like keys, but never render them.
  const COPY_CORE = join(SRC, 'lib/copy/index.ts')
  const files = sourceFiles(SRC).filter(
    (file) =>
      !rel(file).startsWith('src/lib/copy/') &&
      staticSpecifiers(readFileSync(file, 'utf8')).some(
        (spec) => resolveLocal(spec, file) === COPY_CORE,
      ),
  )

  it('every module loads the namespace of every key it names', () => {
    const missing: string[] = []
    for (const file of files) {
      const used = namespacesUsed(readFileSync(file, 'utf8'))
      if (used.size === 0) continue
      const loaded = namespacesLoaded(file)
      for (const ns of used) if (!loaded.has(ns)) missing.push(`${rel(file)} uses ${ns}.*`)
    }
    expect(missing).toEqual([])
  })

  it('finds the modules that use feature copy (self-check)', () => {
    const using = (path: string) => namespacesUsed(readFileSync(join(SRC, path), 'utf8'))
    expect([...using('components/events/effectLabels.ts')]).toContain('events')
    expect([...using('lib/world/placeActionCopy.ts')]).toContain('place')
    expect([...using('lib/economyCopy.ts')]).toEqual(expect.arrayContaining(['clout', 'housing']))
    expect(namespacesLoaded(join(SRC, 'components/places/PlaceSheet.tsx'))).toEqual(
      new Set([
        ...BOOT_NAMESPACES,
        'place',
        'club',
        'venues',
        'landmarks',
        'boroughs',
        'places',
        'jobs',
        'clout',
        'housing',
        'rent',
        // S10a: the shop section (ShopSection → shopCopy) renders in the place sheet.
        'shop',
        'items',
        'inventory',
        // S08: the "Get there" rows, the trip progress card and the home card.
        'travel',
      ]),
    )
  })

  it('the key scanner sees literal and template keys only for real namespaces (self-check)', () => {
    expect([...namespacesUsed("copy('events.ui.continue')")]).toEqual(['events'])
    expect([...namespacesUsed('copy(`items.slots.${slot}.name`)')]).toEqual(['items'])
    expect([...namespacesUsed("load('config.json'); x(`nope.${a}`)")]).toEqual([])
  })
})
