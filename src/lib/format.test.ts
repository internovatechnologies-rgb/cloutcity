import { join } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import {
  formatCount,
  formatDate,
  formatGameTime,
  formatMoney,
  formatPercent,
  formatProgressCount,
} from './format'

const ROOT = join(import.meta.dirname, '../..')

describe('formatMoney', () => {
  it('shows whole dollars, rounding halves away from zero', () => {
    expect(formatMoney(150)).toBe('$150')
    expect(formatMoney(206.57)).toBe('$207')
    expect(formatMoney(12.49)).toBe('$12')
    expect(formatMoney(12.5)).toBe('$13')
    expect(formatMoney(-12.5)).toBe('-$13')
    expect(formatMoney(1100)).toBe('$1,100')
  })

  it('never shows a negative zero', () => {
    expect(formatMoney(-0.4)).toBe('$0')
    expect(formatMoney(-0)).toBe('$0')
  })

  it('rejects non-finite values', () => {
    expect(() => formatMoney(Number.NaN)).toThrow(RangeError)
    expect(() => formatMoney(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('formatCount', () => {
  it('uses compact notation', () => {
    expect(formatCount(6)).toBe('6')
    expect(formatCount(950)).toBe('950')
    expect(formatCount(1500)).toBe('1.5K')
    expect(formatCount(15_274)).toBe('15K')
    expect(formatCount(1_380_000)).toBe('1.4M')
    expect(formatCount(15_274_000)).toBe('15M')
  })

  it('rejects non-finite values', () => {
    expect(() => formatCount(Number.NaN)).toThrow(RangeError)
  })
})

describe('ad-hoc number formatting (UX-2)', () => {
  const eslint = new ESLint({ cwd: ROOT })
  const ruleIds = async (code: string, filePath: string) => {
    const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath) })
    return (result?.messages ?? []).map((m) => m.ruleId)
  }

  it('is a lint error anywhere in src/ except the formatter module', async () => {
    const samples = [
      "export const a = new Intl.NumberFormat('en-US').format(1)\n",
      "export const b = Intl.NumberFormat('en-US').format(1)\n",
      'export const c = (1234).toLocaleString()\n',
      'export const d = (12.5).toFixed(0)\n',
    ]
    for (const code of samples) {
      expect(await ruleIds(code, 'src/components/Probe.tsx'), code).toContain(
        'no-restricted-syntax',
      )
      expect(await ruleIds(code, 'src/lib/format.ts'), code).not.toContain('no-restricted-syntax')
    }
  }, 30_000)

  it.each([
    ['destructuring from Intl', 'const { NumberFormat } = Intl\nexport const a = NumberFormat\n'],
    ['globalThis.Intl', 'export const a = globalThis.Intl.NumberFormat\n'],
    ['window.Intl', 'export const a = window.Intl.DateTimeFormat\n'],
    ['computed Intl access', "export const a = Intl['NumberFormat']\n"],
    ['an Intl alias', 'const I = Intl\nexport const a = I\n'],
    ['toLocaleString via .call', 'export const a = Number.prototype.toLocaleString.call(5)\n'],
    ['computed toFixed', "export const a = (5)['toFixed'](0)\n"],
    ['computed toPrecision in a template', 'export const a = (5)[`toPrecision`](2)\n'],
    ['destructured toFixed', 'const { toFixed } = Number.prototype\nexport const a = toFixed\n'],
    ['a "$" template amount', 'const x = 5\nexport const a = `$${x}`\n'],
    ['a "$" amount inside a template', 'const x = 5\nexport const a = `Rent: $${x}/wk`\n'],
    ['"$" + value', "const x = 5\nexport const a = '$' + x\n"],
    [
      '"$" before a JSX expression',
      'const x = 5\nexport function A() {\n  return <p>${x}</p>\n}\n',
    ],
  ])(
    'reports %s outside the formatter module',
    async (_label, code) => {
      expect(await ruleIds(code, 'src/components/Probe.tsx')).toContain('no-restricted-syntax')
    },
    30_000,
  )

  it.each([
    ['a plain template', 'const x = 5\nexport const a = `${x} people`\n'],
    ['a CSS variable template', "const x = 'pink'\nexport const a = `--palette-${x}`\n"],
    ['string concatenation', "export const a = 'a' + 'b'\n"],
  ])(
    'does not report %s',
    async (_label, code) => {
      expect(await ruleIds(code, 'src/components/Probe.tsx')).not.toContain('no-restricted-syntax')
    },
    30_000,
  )
})

describe('formatMoney edge cases', () => {
  it('rounds every half away from zero (halfExpand), not to even', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5].map(formatMoney)).toEqual([
      '$1',
      '$2',
      '$3',
      '-$1',
      '-$2',
      '-$3',
    ])
  })

  it('shows large and negative amounts as whole dollars with grouping', () => {
    expect(formatMoney(1e9)).toBe('$1,000,000,000')
    expect(formatMoney(-1_000_000)).toBe('-$1,000,000')
    expect(formatMoney(0)).toBe('$0')
  })

  it('never shows cents', () => {
    for (const value of [0.01, 0.99, 12.345, 999.999, -0.01]) {
      expect(formatMoney(value), String(value)).not.toMatch(/\./)
    }
  })

  it('rejects negative infinity', () => {
    expect(() => formatMoney(Number.NEGATIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('formatCount edge cases', () => {
  it('rolls over to the next unit at the compact rounding boundary', () => {
    expect(formatCount(999)).toBe('999')
    expect(formatCount(999_499)).toBe('999K')
    expect(formatCount(999_950)).toBe('1M')
    expect(formatCount(99_950)).toBe('100K')
  })

  it('handles billions and negatives', () => {
    expect(formatCount(1e9)).toBe('1B')
    expect(formatCount(-1500)).toBe('-1.5K')
    expect(formatCount(0)).toBe('0')
  })

  it('rounds to a whole count first and never shows -0', () => {
    expect(formatCount(0.4)).toBe('0')
    expect(formatCount(2.5)).toBe('3')
    expect(formatCount(6.6)).toBe('7')
    expect(formatCount(-0.4)).toBe('0')
    expect(formatCount(-0)).toBe('0')
    expect(formatCount(999.6)).toBe('1K')
  })

  it('rejects infinities', () => {
    expect(() => formatCount(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => formatCount(Number.NEGATIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('formatPercent', () => {
  it('formats whole-percent slider values', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(80)).toBe('80%')
    expect(formatPercent(100)).toBe('100%')
    expect(formatPercent(12.4)).toBe('12%')
  })

  it('rejects non-finite values', () => {
    expect(() => formatPercent(Number.NaN)).toThrow(RangeError)
  })
})

describe('formatGameTime (S05)', () => {
  it('shows the minute of day on a 12-hour clock', () => {
    expect(formatGameTime(480)).toBe('8:00 AM')
    expect(formatGameTime(0)).toBe('12:00 AM')
    expect(formatGameTime(12 * 60)).toBe('12:00 PM')
    expect(formatGameTime(13 * 60 + 5)).toBe('1:05 PM')
    expect(formatGameTime(1439)).toBe('11:59 PM')
  })

  it('uses a plain space before the day period', () => {
    expect(formatGameTime(480)).toMatch(/^8:00 AM$/)
    expect(formatGameTime(480)).not.toMatch(/ | /)
  })

  it('does not depend on the host time zone', () => {
    const zone = process.env.TZ
    try {
      process.env.TZ = 'Pacific/Kiritimati'
      expect(formatGameTime(480)).toBe('8:00 AM')
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it('rejects a minute outside one day or a fraction', () => {
    for (const bad of [-1, 1440, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatGameTime(bad), String(bad)).toThrow(RangeError)
    }
  })
})

describe('formatDate', () => {
  it('writes a calendar date in the given zone, from epoch ms or an ISO timestamp', () => {
    expect(formatDate(Date.UTC(2026, 9, 9, 15), 'America/New_York')).toBe('October 9, 2026')
    expect(formatDate('2026-10-10T02:00:00Z', 'America/New_York')).toBe('October 9, 2026')
    expect(formatDate('2026-10-10T02:00:00Z', 'UTC')).toBe('October 10, 2026')
  })

  it('refuses an instant that is not a date', () => {
    expect(() => formatDate('not a date')).toThrow(RangeError)
    expect(() => formatDate(Number.NaN)).toThrow(RangeError)
  })
})

describe('formatProgressCount (the clout meter: never rounded up to the target)', () => {
  it.each([
    [0, '0'],
    [304, '304'],
    [4996, '4,996'],
    [4999.9, '4,999'],
    [5000, '5,000'],
    [9999, '9,999'],
    [10_000, '10K'],
    [15_274, '15K'],
    [19_990, '19K'],
    [1_999_999, '1.9M'],
  ])('%d reads %s', (count, text) => {
    expect(formatProgressCount(count)).toBe(text)
  })

  it('4,996 of 5,000 never reads as the target', () => {
    expect(formatProgressCount(4996)).not.toBe(formatProgressCount(5000))
  })

  it('rejects a non-finite count', () => {
    expect(() => formatProgressCount(Number.NaN)).toThrow(RangeError)
  })
})
