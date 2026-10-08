/**
 * Crisis resources (S18b) are slang-immune: the 988 and 911 lines read the same in every slang
 * pack, so a playful rewrite can never blur them.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseCopy } from './all'
import { SLANG_IMMUNE_KEY, lookupTemplate, registerCopy, registeredNamespace } from './registry'

const COPY_DIR = resolve(import.meta.dirname, '../../../data/copy')

describe('slang-immune copy', () => {
  it('covers the crisis lines of the report form and the Code of Conduct', () => {
    const immune = Object.keys(baseCopy.strings).filter((key) => SLANG_IMMUNE_KEY.test(key))
    expect(immune).toEqual(
      expect.arrayContaining([
        'safety.crisis.988',
        'safety.crisis.911',
        'legal.conduct.crisis.988',
        'legal.conduct.crisis.911',
      ]),
    )
  })

  it('no pack file on disk overrides an immune key', () => {
    const overrides: string[] = []
    for (const ns of readdirSync(COPY_DIR, { withFileTypes: true })) {
      if (!ns.isDirectory()) continue
      for (const file of readdirSync(join(COPY_DIR, ns.name))) {
        if (file === 'base.json') continue
        const { strings } = JSON.parse(readFileSync(join(COPY_DIR, ns.name, file), 'utf8')) as {
          strings: Record<string, string>
        }
        overrides.push(...Object.keys(strings).filter((key) => SLANG_IMMUNE_KEY.test(key)))
      }
    }
    expect(overrides).toEqual([])
  })

  it('a pack that tries to override an immune key is ignored for it', () => {
    const original = registeredNamespace('safety')
    if (original === undefined) throw new Error('safety namespace is not registered')
    try {
      registerCopy('safety', original.base, {
        nyc: {
          strings: {
            'safety.crisis.988': 'Hit up 988, fam',
            'safety.toast.close': 'Bounce',
          },
        },
      })
      expect(lookupTemplate('safety.crisis.988', 'nyc')).toBe(
        original.base.strings['safety.crisis.988'],
      )
      expect(lookupTemplate('safety.toast.close', 'nyc')).toBe('Bounce')
    } finally {
      registerCopy('safety', original.base, original.packs)
    }
  })
})
