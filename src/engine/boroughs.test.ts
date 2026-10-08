import { describe, expect, it } from 'vitest'
import { boroughAccess, boroughAccessAll } from './boroughs'
import { engineConfig, type EngineConfig } from './config'

const levels = engineConfig.clout.levels
const minClout = (id: string) => {
  const level = levels.find((entry) => entry.id === id)
  if (level === undefined) throw new Error(`no level ${id}`)
  return level.minClout
}
const indexOf = (id: string) => levels.findIndex((entry) => entry.id === id)

describe('boroughAccess across every clout level', () => {
  it.each(levels.map((level) => [level.id, level.minClout] as const))(
    'at %s (%i clout)',
    (id, clout) => {
      const all = boroughAccessAll(clout, engineConfig)
      expect(all.queens).toEqual({ status: 'open' })
      expect(all.bronx).toEqual({ status: 'expanding-soon' })
      expect(all['staten-island']).toEqual({ status: 'expanding-soon' })
      expect(all.brooklyn).toEqual(
        indexOf(id) >= indexOf('local')
          ? { status: 'open' }
          : { status: 'locked', required: 'local', current: id },
      )
      expect(all.manhattan).toEqual(
        indexOf(id) >= indexOf('scene-regular')
          ? { status: 'open' }
          : { status: 'locked', required: 'scene-regular', current: id },
      )
    },
  )

  it('opens Brooklyn exactly at local and Manhattan exactly at scene-regular', () => {
    expect(boroughAccess('brooklyn', minClout('local') - 1, engineConfig).status).toBe('locked')
    expect(boroughAccess('brooklyn', minClout('local'), engineConfig).status).toBe('open')
    expect(boroughAccess('manhattan', minClout('scene-regular') - 1, engineConfig)).toEqual({
      status: 'locked',
      required: 'scene-regular',
      current: 'local',
    })
    expect(boroughAccess('manhattan', minClout('scene-regular'), engineConfig).status).toBe('open')
  })

  it('keeps the Bronx and Staten Island expanding soon even at icon', () => {
    const clout = minClout('icon') * 10
    expect(boroughAccess('bronx', clout, engineConfig).status).toBe('expanding-soon')
    expect(boroughAccess('staten-island', clout, engineConfig).status).toBe('expanding-soon')
  })

  it('follows the config: thresholds and rules come from balance, not code', () => {
    const config: EngineConfig = {
      ...engineConfig,
      boroughs: {
        ...engineConfig.boroughs,
        queens: { access: 'clout', level: 'known' },
        brooklyn: { access: 'open' },
        bronx: { access: 'clout', level: 'local' },
      },
    }
    expect(boroughAccess('queens', 0, config)).toEqual({
      status: 'locked',
      required: 'known',
      current: 'nobody',
    })
    expect(boroughAccess('brooklyn', 0, config).status).toBe('open')
    expect(boroughAccess('bronx', minClout('local'), config).status).toBe('open')
  })

  it('throws on a rule naming an unknown level instead of opening the borough', () => {
    const config: EngineConfig = {
      ...engineConfig,
      boroughs: { ...engineConfig.boroughs, brooklyn: { access: 'clout', level: 'mayor' } },
    }
    expect(() => boroughAccess('brooklyn', 1_000_000, config)).toThrow(/mayor/)
  })
})

describe('boroughAccess fails closed', () => {
  it('keeps clout-gated boroughs locked on zero, negative or NaN clout', () => {
    for (const clout of [0, -1, -1_000_000, Number.NaN]) {
      expect(boroughAccess('brooklyn', clout, engineConfig), String(clout)).toEqual({
        status: 'locked',
        required: 'local',
        current: 'nobody',
      })
      expect(boroughAccess('manhattan', clout, engineConfig).status, String(clout)).toBe('locked')
    }
  })

  it.each(['brooklyn', 'manhattan', 'queens', 'bronx', 'staten-island'] as const)(
    'throws (never opens) when %s names a level missing from config',
    (borough) => {
      const config: EngineConfig = {
        ...engineConfig,
        boroughs: { ...engineConfig.boroughs, [borough]: { access: 'clout', level: 'ghost' } },
      }
      for (const clout of [0, minClout('icon'), Number.POSITIVE_INFINITY]) {
        expect(() => boroughAccess(borough, clout, config)).toThrow(/ghost/)
      }
      expect(() => boroughAccessAll(0, config)).toThrow(/ghost/)
    },
  )

  it('every level x borough cell at one clout below and at each threshold', () => {
    const rank = (borough: 'brooklyn' | 'manhattan') =>
      indexOf(borough === 'brooklyn' ? 'local' : 'scene-regular')
    for (const [index, level] of levels.entries()) {
      for (const clout of [level.minClout - 1, level.minClout]) {
        const current = clout < level.minClout ? Math.max(0, index - 1) : index
        const all = boroughAccessAll(clout, engineConfig)
        for (const borough of ['brooklyn', 'manhattan'] as const) {
          expect(all[borough].status, `${borough} at ${clout}`).toBe(
            current >= rank(borough) ? 'open' : 'locked',
          )
        }
        expect(all.queens.status).toBe('open')
        expect(all.bronx.status).toBe('expanding-soon')
        expect(all['staten-island'].status).toBe('expanding-soon')
      }
    }
  })
})
