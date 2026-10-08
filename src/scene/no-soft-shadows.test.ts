import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// CLAUDE.md "Performance budgets": any shadow uses PCFShadowMap, never PCFSoftShadowMap, and
// no tier has a postprocessing pass (perf.json `postprocessing: "none"`). R3F turns a boolean
// `shadows` prop into PCFSoftShadowMap, so the canvas must pass an object.

const ROOT = join(import.meta.dirname, '../..')
const SRC = join(ROOT, 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

/** Source without comments: docs may name what the code must never use. */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const files = sourceFiles(SRC).map((path) => ({
  path: relative(ROOT, path),
  text: stripComments(readFileSync(path, 'utf8')),
}))

describe('shadows and postprocessing (static guard)', () => {
  it('scans the source tree', () => {
    expect(files.some((file) => file.path === 'src/scene/CityCanvas.tsx')).toBe(true)
  })

  it('never uses PCFSoftShadowMap, VSM or a boolean/string `shadows` prop', () => {
    const offenders = files.filter((file) => /PCFSoftShadowMap|VSMShadowMap/.test(file.text))
    expect(offenders.map((file) => file.path)).toEqual([])
    const booleanShadows = files.filter((file) =>
      /\bshadows(=\{(true|false)\}|=["']|\s*[/>])/.test(file.text),
    )
    expect(booleanShadows.map((file) => file.path)).toEqual([])
  })

  it('names PCFShadowMap wherever the canvas sets shadows', () => {
    const canvas = files.find((file) => file.path === 'src/scene/CityCanvas.tsx')
    expect(canvas?.text).toMatch(/shadows=\{shadows \? SHADOWS_ON : SHADOWS_OFF\}/)
    expect(canvas?.text.match(/type: PCFShadowMap/g)).toHaveLength(2)
  })

  it('imports no postprocessing library or EffectComposer', () => {
    const offenders = files.filter((file) =>
      /from ['"](@react-three\/postprocessing|postprocessing|three\/addons\/postprocessing\/[^'"]*)['"]|EffectComposer/.test(
        file.text,
      ),
    )
    expect(offenders.map((file) => file.path)).toEqual([])
  })
})
