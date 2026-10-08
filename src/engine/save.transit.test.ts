/** Save v10 (S08): the player's location and the transit generator; migration from v9 and every older version; repairs. */
import { describe, expect, it } from 'vitest'
import { engineConfig as config } from './config'
import { HOME_LOCATION, initialTransitState } from './game'
import {
  SAVE_VERSION,
  createSaveSchema,
  initialSave,
  loadSave,
  migrateSave,
  type SaveState,
} from './save'

const schema = createSaveSchema(config)
const NOW = 30_000
const base: SaveState = { ...initialSave(config), clock: { minute: NOW, remainderMs: 0 } }
const PLACE = 'late-lantern-deli'

/** A v10 save standing at a place, with a used generator. */
const out: SaveState = {
  ...base,
  player: {
    ...base.player,
    location: { kind: 'place', placeId: PLACE },
    transit: { rngState: 123_456 },
  },
}

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

function load(save: unknown) {
  const result = loadSave(roundTrip(save), config)
  if (!result.ok) throw new Error(`unusable: ${result.issues.join(', ')}`)
  return result
}

/** `save` as v9 wrote it: no location and no transit state. */
function v9Of(save: SaveState = base): Record<string, unknown> & {
  player: Record<string, unknown>
} {
  const player: Record<string, unknown> = { ...save.player }
  delete player.location
  delete player.transit
  // Nor the S18c (v11) action count.
  const out: Record<string, unknown> = { ...save, player }
  delete out.actions
  return out as Record<string, unknown> & { player: Record<string, unknown> }
}

const withPlayer = (patch: Record<string, unknown>) => ({
  ...out,
  player: { ...out.player, ...patch },
})

describe('save v10', () => {
  it('is version 11 (S18c after S08) and a fresh save starts at home with a fresh generator', () => {
    expect(SAVE_VERSION).toBe(11)
    const fresh = initialSave(config)
    expect(fresh.player.location).toEqual(HOME_LOCATION)
    expect(fresh.player.transit).toEqual(initialTransitState)
    expect(schema.safeParse(fresh).success).toBe(true)
  })

  it('round-trips a location and a generator state untouched', () => {
    expect(schema.safeParse(out).success).toBe(true)
    expect(loadSave(roundTrip(out), config)).toEqual({ ok: true, save: out, repaired: [] })
  })

  it('the schema refuses an unknown place and a generator state that is not a uint32', () => {
    expect(
      schema.safeParse(withPlayer({ location: { kind: 'place', placeId: 'nowhere' } })).success,
    ).toBe(false)
    expect(schema.safeParse(withPlayer({ transit: { rngState: -1 } })).success).toBe(false)
  })
})

describe('v9 -> v10', () => {
  it('a v9 save keeps everything and starts at home with a fresh generator (not a repair)', () => {
    const v9 = { ...v9Of(), player: { ...v9Of().player, cash: 909 } }
    const migrated = migrateSave(roundTrip(v9), 9, config)
    expect(migrated.outcome).toBe('carried')
    expect(migrated.save.player.cash).toBe(909)
    expect(migrated.save.player.location).toEqual(HOME_LOCATION)
    expect(migrated.save.player.transit).toEqual(initialTransitState)
    expect(schema.safeParse(migrated.save).success).toBe(true)
    expect(load(v9).repaired).toEqual([])
  })

  it('every version v1 to v11 loads, carrying its progress (INT-12/13)', () => {
    const player = v9Of().player
    const legacy = (version: number): Record<string, unknown> => {
      const save: Record<string, unknown> = { ...v9Of() }
      const p: Record<string, unknown> = { ...player, cash: 500 + version }
      if (version < 9) {
        delete p.apartment
        const inventory: Record<string, unknown> = { ...base.player.inventory }
        delete inventory.decor
        p.inventory = inventory
      }
      if (version < 8) {
        delete p.visited
        delete save.goals
        delete save.grants
        delete save.prestige
      }
      if (version < 7) {
        p.clout = 0
        delete p.flex
      }
      if (version < 6) delete p.clubNights
      if (version < 5) delete save.events
      if (version < 4) delete p.inventory
      return { ...save, player: p }
    }
    const saves: Record<number, unknown> = {
      1: { player: { cash: 501 } },
      2: { clock: base.clock, player: { cash: 502, stats: base.player.stats }, speed: 1 },
      3: legacy(3),
      4: legacy(4),
      5: legacy(5),
      6: legacy(6),
      7: legacy(7),
      8: legacy(8),
      9: legacy(9),
      // v10 (S08): everything but the S18c action count.
      10: (() => {
        const v10: Record<string, unknown> = { ...out, player: { ...out.player, cash: 510 } }
        delete v10.actions
        return v10
      })(),
    }
    for (const [version, persisted] of Object.entries(saves)) {
      const migrated = migrateSave(roundTrip(persisted), Number(version), config)
      expect(migrated.outcome, `v${version}`).toBe('carried')
      expect(migrated.save.player.cash, `v${version}`).toBe(500 + Number(version))
      if (version !== '10') {
        expect(migrated.save.player.location, `v${version}`).toEqual(HOME_LOCATION)
      }
      expect(migrated.save.actions, `v${version}`).toBe(0)
      expect(schema.safeParse(migrated.save).success, `v${version}`).toBe(true)
    }
    const v11 = load({ ...out, actions: 7, player: { ...out.player, cash: 511 } })
    expect(v11.save.player.cash).toBe(511)
    expect(v11.save.player.location).toEqual(out.player.location)
    expect(v11.save.actions).toBe(7)
    expect(v11.repaired).toEqual([])
  })
})

describe('v10 repairs', () => {
  it.each([
    ['a place the config does not know', { kind: 'place', placeId: 'nowhere' }],
    ['a place id that is not a string', { kind: 'place', placeId: 7 }],
    ['an unknown kind', { kind: 'street' }],
    ['a prototype key', { kind: 'place', placeId: '__proto__' }],
    ['not an object', 'home'],
    ['extra keys', { kind: 'home', placeId: PLACE }],
  ])('puts the player at home for %s', (_label, location) => {
    const result = load(withPlayer({ location }))
    expect(result.save.player.location).toEqual(HOME_LOCATION)
    expect(result.repaired).toEqual(['player.location'])
  })

  it.each([
    ['negative', { rngState: -1 }, 0],
    ['fractional', { rngState: 1.5 }, 0],
    ['too big', { rngState: 2 ** 32 }, 0],
    ['extra keys, a good state kept', { rngState: 42, extra: true }, 42],
    ['not an object', 5, 0],
  ])('repairs a %s generator state', (_label, transit, rngState) => {
    const result = load(withPlayer({ transit }))
    expect(result.save.player.transit).toEqual({ rngState })
    expect(result.repaired).toEqual(['player.transit'])
  })
})
