/**
 * The copy files on disk (S05c): data/copy/<ns>/base.json, optional data/copy/<ns>/<pack>.json,
 * data/copy/superlatives.json and data/copy/handleWords.json (S18a), and the namespace modules
 * that register them.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import copyConfigJson from '@data/config/copy.json'
import { CopyConfigSchema } from '@/lib/data/schemas/config'
import { NamespaceBaseSchema, SlangPackSchema, SuperlativesSchema } from '@/lib/data/schemas/copy'
import { HandleWordsSchema } from '@/lib/data/schemas/handles'
import { placeholdersOf } from '@/lib/placeholders'
import { BOOT_NAMESPACES } from './index'
import { registeredNamespace, registeredNamespaces } from './registry'
import './all'

const COPY_DIR = join(import.meta.dirname, '../../../data/copy')
const NS_DIR = join(import.meta.dirname, 'ns')

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

const namespaceDirs = readdirSync(COPY_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const config = CopyConfigSchema.parse(copyConfigJson)

function packFiles(namespace: string): string[] {
  return readdirSync(join(COPY_DIR, namespace))
    .filter((name) => name !== 'base.json')
    .map((name) => name.replace(/\.json$/, ''))
    .sort()
}

function baseStrings(namespace: string): Record<string, string> {
  return NamespaceBaseSchema.parse(readJson(join(COPY_DIR, namespace, 'base.json'))).strings
}

describe('copy files', () => {
  it('data/copy holds only namespace directories, superlatives.json and handleWords.json', () => {
    const files = readdirSync(COPY_DIR, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(files).toEqual(['handleWords.json', 'superlatives.json'])
    expect(
      SuperlativesSchema.safeParse(readJson(join(COPY_DIR, 'superlatives.json'))).success,
    ).toBe(true)
    expect(HandleWordsSchema.safeParse(readJson(join(COPY_DIR, 'handleWords.json'))).success).toBe(
      true,
    )
  })

  it('the copy config names its active pack among its packs', () => {
    expect(config.packs).toContain(config.slangPack)
  })

  it.each(namespaceDirs)(
    '%s: base.json matches its schema and every key is in the namespace',
    (ns) => {
      const strings = baseStrings(ns)
      expect(Object.keys(strings).length).toBeGreaterThan(0)
      expect(Object.keys(strings).filter((key) => !key.startsWith(`${ns}.`))).toEqual([])
    },
  )

  it.each(namespaceDirs)(
    '%s: pack files are known packs and override base keys with the same placeholders',
    (ns) => {
      const base = baseStrings(ns)
      for (const id of packFiles(ns)) {
        expect(config.packs, `${ns}/${id}.json is not a pack in config/copy.json`).toContain(id)
        const pack = SlangPackSchema.parse(readJson(join(COPY_DIR, ns, `${id}.json`)))
        expect(pack.id, `${ns}/${id}.json`).toBe(id)
        expect(Object.keys(pack.strings).length, `${ns}/${id}.json is empty`).toBeGreaterThan(0)
        for (const [key, text] of Object.entries(pack.strings)) {
          const template = base[key]
          expect(template, `${ns}/${id}.json: ${key} is not a base key`).toBeDefined()
          expect(placeholdersOf(text).sort(), `${ns}/${id}.json: ${key}`).toEqual(
            placeholdersOf(template ?? '').sort(),
          )
        }
      }
    },
  )

  it('every namespace directory has a module, and every module a directory', () => {
    const modules = readdirSync(NS_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replace(/\.ts$/, ''))
      .sort()
    expect(modules).toEqual(namespaceDirs)
  })

  it('each module registers exactly the files on disk (all.ts imports every module)', () => {
    expect(registeredNamespaces().sort()).toEqual(namespaceDirs)
    for (const ns of namespaceDirs) {
      const entry = registeredNamespace(ns)
      expect(entry?.base.strings, ns).toEqual(baseStrings(ns))
      expect(Object.keys(entry?.packs ?? {}).sort(), ns).toEqual(packFiles(ns))
      for (const id of packFiles(ns)) {
        expect(entry?.packs[id], `${ns}/${id}`).toEqual(readJson(join(COPY_DIR, ns, `${id}.json`)))
      }
    }
  })

  it('the boot namespaces exist and the copy core imports exactly them', () => {
    const core = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8')
    const imported = [...core.matchAll(/^import '\.\/ns\/(\w+)'$/gm)].map((match) => match[1])
    expect(imported.sort()).toEqual([...BOOT_NAMESPACES].sort())
    for (const ns of BOOT_NAMESPACES) expect(namespaceDirs).toContain(ns)
  })
})
