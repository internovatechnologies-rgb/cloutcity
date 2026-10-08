/**
 * perf.json `models` caps (S04h, TUNE-12): every committed tier is within its category's cap,
 * an over-cap model is reported, and the asset build never writes perf.json.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelManifestSchema } from '../../src/lib/data/schemas/assets.ts'
import { PerfConfigSchema } from '../../src/lib/data/schemas/config.ts'
import { capViolations, pressureReport } from './build.ts'

const ROOT = join(import.meta.dirname, '../..')
const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
const manifest = ModelManifestSchema.parse(read('data/assets/manifest.json'))
const perf = PerfConfigSchema.parse(read('data/config/perf.json'))

describe('model budgets', () => {
  it('keeps every committed tier within its perf.json cap', () => {
    expect(capViolations(manifest, perf.models)).toEqual([])
  })

  it('reports a model over its triangle or gzip cap', () => {
    const [model] = manifest.models
    if (model === undefined) throw new Error('manifest is empty')
    const cap = perf.models[model.category]
    const heavy = {
      ...manifest,
      models: [
        {
          ...model,
          tiers: {
            ...model.tiers,
            low: {
              ...model.tiers.low,
              triangles: cap.trianglesMax.low + 1,
              gzBytes: cap.gzKBMax * 1000 + 1,
            },
          },
        },
      ],
    }
    expect(capViolations(heavy, perf.models).map((v) => `${v.id} ${v.tier}`)).toEqual([
      `${model.id} low`,
      `${model.id} low`,
    ])
  })

  it('prints pressure for every category and the per-set totals', () => {
    const report = pressureReport(manifest, perf.models).join('\n')
    for (const category of Object.keys(perf.models)) expect(report).toContain(category)
    for (const set of ['street props', 'buildings', 'apartment', 'creator parts', 'avatar']) {
      expect(report).toContain(set)
    }
  })

  it('never writes perf.json (the build reads caps; humans set them)', () => {
    const source = readFileSync(join(ROOT, 'scripts/assets/build.ts'), 'utf8')
    expect(source).not.toMatch(/writeFile\([^)]*PERF_PATH/)
    expect([...source.matchAll(/PERF_PATH/g)]).toHaveLength(2)
  })
})
