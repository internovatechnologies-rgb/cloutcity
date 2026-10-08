/**
 * config/perf.json must hold every row and tier of the CLAUDE.md "Performance budgets" table.
 * The expected values are parsed from CLAUDE.md itself, not restated here, so a budget change
 * in CLAUDE.md that is not mirrored in perf.json (or a new row nobody mapped) fails this test.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import perfJson from '@data/config/perf.json'

const CLAUDE_MD = readFileSync(join(import.meta.dirname, '../../../CLAUDE.md'), 'utf8')
const TIERS = ['low', 'mid', 'high'] as const
type Tier = (typeof TIERS)[number]

function budgetSection(): string {
  const start = CLAUDE_MD.indexOf('## Performance budgets')
  if (start < 0) throw new Error('CLAUDE.md has no "## Performance budgets" section')
  const end = CLAUDE_MD.indexOf('\n## ', start + 1)
  return CLAUDE_MD.slice(start, end < 0 ? undefined : end)
}

/** Table rows as [label, low, mid, high], with "same" resolved to the low value. */
function tableRows(): Map<string, Record<Tier, string>> {
  const rows = new Map<string, Record<Tier, string>>()
  for (const line of budgetSection().split('\n')) {
    if (!line.startsWith('|') || line.startsWith('|---') || line.startsWith('| Budget')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    const [label, low, mid, high] = cells
    if (label === undefined || low === undefined || mid === undefined || high === undefined) {
      throw new Error(`Unparseable budget row: ${line}`)
    }
    const same = (cell: string) => (cell === 'same' ? low : cell)
    rows.set(label, { low, mid: same(mid), high: same(high) })
  }
  return rows
}

/** "≤ 180 KB" → 180, "≤ 1.2 MB" → 1200 (KB = 1000 bytes, as scripts/budget.ts uses). */
function kb(cell: string): number {
  const match = /^≤ ([\d.]+) (KB|MB)$/.exec(cell)
  if (!match) throw new Error(`Not a size budget: ${cell}`)
  const value = Number(match[1])
  return match[2] === 'MB' ? Math.round(value * 1000) : value
}

/** "≤ 2.5 s" → 2500. */
function ms(cell: string): number {
  const match = /^≤ ([\d.]+) s$/.exec(cell)
  if (!match) throw new Error(`Not a time budget: ${cell}`)
  return Math.round(Number(match[1]) * 1000)
}

/** "≤ 60" → 60, "≤ 150k" → 150000, "≥ 30" → 30, "1.5" → 1.5, "8 (billboards)" → 8. */
function num(cell: string): number {
  const match = /^(?:[≤≥] )?([\d.]+)(k)?(?: \(.*\))?$/.exec(cell)
  if (!match) throw new Error(`Not a numeric budget: ${cell}`)
  return Number(match[1]) * (match[2] ? 1000 : 1)
}

function shadow(cell: string): string {
  if (cell === 'none') return 'none'
  if (cell === 'blob/baked') return 'blob-or-baked'
  if (/one directional `PCFShadowMap`/.test(cell)) return 'pcf-directional'
  throw new Error(`Unknown shadow budget: ${cell}`)
}

const perTier = (cells: Record<Tier, string>, parse: (cell: string) => number | string) =>
  Object.fromEntries(TIERS.map((tier) => [tier, parse(cells[tier])]))

/** Each CLAUDE.md row (by label prefix) → the perf.json key and how its cells parse. */
const ROW_MAP: readonly {
  readonly label: string
  readonly key: keyof typeof perfJson
  readonly expected: (cells: Record<Tier, string>) => unknown
}[] = [
  { label: 'Shell JS', key: 'shellJsGzKB', expected: (c) => kb(c.low) },
  { label: '3D chunk JS', key: 'sceneChunkJsGzKB', expected: (c) => kb(c.low) },
  { label: 'Total JS to playable', key: 'totalJsToPlayableGzKB', expected: (c) => kb(c.low) },
  { label: 'Base geo', key: 'baseGeoGzKB', expected: (c) => kb(c.low) },
  { label: 'District buildings', key: 'districtBuildingsGzKB', expected: (c) => perTier(c, kb) },
  {
    label: 'Total bytes to playable',
    key: 'totalBytesToPlayableGzKB',
    expected: (c) => perTier(c, kb),
  },
  {
    label: 'Shell visible and interactive',
    key: 'shellInteractiveColdMs',
    expected: (c) => ms(c.low),
  },
  { label: 'Playable (city drawn', key: 'playableColdMs', expected: (c) => perTier(c, ms) },
  { label: 'Playable, warm', key: 'playableWarmMs', expected: (c) => ms(c.low) },
  { label: 'Draw calls', key: 'drawCallsMax', expected: (c) => perTier(c, num) },
  { label: 'Triangles', key: 'trianglesMax', expected: (c) => perTier(c, num) },
  { label: 'Device pixel ratio cap', key: 'dprCap', expected: (c) => perTier(c, num) },
  { label: 'Shadows', key: 'shadows', expected: (c) => perTier(c, shadow) },
  { label: 'Other players rendered', key: 'otherPlayersMax', expected: (c) => perTier(c, num) },
  { label: 'Median FPS', key: 'medianFpsMin', expected: (c) => perTier(c, num) },
]

describe('config/perf.json against CLAUDE.md "Performance budgets"', () => {
  const rows = tableRows()

  it('maps every table row, so a new budget row cannot be forgotten', () => {
    const unmapped = [...rows.keys()].filter(
      (label) => !ROW_MAP.some((entry) => label.startsWith(entry.label)),
    )
    expect(unmapped).toEqual([])
    expect(rows.size).toBe(ROW_MAP.length)
  })

  it.each(ROW_MAP)('$key matches the "$label" row', ({ label, key, expected }) => {
    const row = [...rows.entries()].find(([rowLabel]) => rowLabel.startsWith(label))
    if (row === undefined) throw new Error(`CLAUDE.md has no "${label}" budget row`)
    expect(perfJson[key]).toEqual(expected(row[1]))
  })

  it('renders other players as billboards on low tier only where CLAUDE.md says so', () => {
    const row = [...rows.entries()].find(([label]) => label.startsWith('Other players rendered'))
    expect(row?.[1].low).toMatch(/billboards/)
    expect(perfJson.otherPlayersStyle.low).toBe('billboard')
  })

  it('matches the cc-mid-4g reference throttle profile', () => {
    const match =
      /`cc-mid-4g`:\*\* (\d+) Mbps down, (\d+) Mbps up, (\d+) ms RTT, (\d+)x CPU slowdown, viewport (\d+)×(\d+)/.exec(
        budgetSection(),
      )
    if (!match) throw new Error('CLAUDE.md cc-mid-4g profile line not found')
    const [, down, up, rtt, cpu, width, height] = match.map(Number)
    expect(perfJson.throttleProfiles['cc-mid-4g']).toEqual({
      downloadKbps: (down ?? 0) * 1000,
      uploadKbps: (up ?? 0) * 1000,
      rttMs: rtt,
      cpuSlowdown: cpu,
      viewport: { width, height },
    })
  })

  it('matches the idle and FPS step-down rules', () => {
    const section = budgetSection()
    expect(section).toMatch(/Idle means zero frames rendered/)
    expect(perfJson.idleFramesMax).toBe(0)
    const stepDown = /average FPS stays below (\d+) for (\d+) s/.exec(section)
    if (!stepDown) throw new Error('CLAUDE.md FPS step-down rule not found')
    expect(perfJson.fpsStepDown).toMatchObject({
      belowFps: Number(stepDown[1]),
      sustainMs: Number(stepDown[2]) * 1000,
    })
  })
})
