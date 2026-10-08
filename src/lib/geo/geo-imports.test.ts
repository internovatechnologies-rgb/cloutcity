/**
 * src/lib/geo is shared by the scene, the engine and the Node geo build: it must stay free of
 * React, three, Supabase and Next, and use only relative `.ts` imports so Node's type
 * stripping can load it from scripts/ (no path aliases, no extensionless specifiers).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = import.meta.dirname
const sources = readdirSync(DIR).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
)

const specifiers = (code: string) =>
  [...code.matchAll(/^\s*(?:import|export)\s[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)].map(
    (match) => match[1] ?? '',
  )

describe('src/lib/geo imports', () => {
  it('finds the modules', () => {
    expect(sources).toEqual(expect.arrayContaining(['projection.ts', 'codec.ts', 'polygon.ts']))
  })

  it.each(sources)('%s imports only sibling .ts modules', (file) => {
    const specs = specifiers(readFileSync(join(DIR, file), 'utf8'))
    expect(specs.filter((spec) => !/^\.\/[a-z-]+\.ts$/.test(spec))).toEqual([])
    expect(specs.filter((spec) => /react|three|@supabase|next/.test(spec))).toEqual([])
  })

  it.each(sources)('%s has no side-effect, dynamic or require imports', (file) => {
    const code = readFileSync(join(DIR, file), 'utf8')
    expect(code).not.toMatch(/^\s*import\s+['"]/m)
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\brequire\s*\(/)
  })

  it('projection.ts has no imports at all', () => {
    expect(specifiers(readFileSync(join(DIR, 'projection.ts'), 'utf8'))).toEqual([])
  })
})
