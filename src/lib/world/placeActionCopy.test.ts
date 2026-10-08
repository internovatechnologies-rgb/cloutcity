import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import { initialSnapshot, type GameSnapshot } from '@/engine/game'
import {
  performPlaceActionHere as performPlaceAction,
  placeActionsHere as placeActions,
  withClout,
} from '@/engine/test-support'
import type { PlaceAction } from '@/engine/placeActions'
import { createCopy } from '@/lib/copy'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { formatMoney } from '@/lib/format'
import { homeActions, performHomeAction } from '@/engine/placeActions'
import {
  clubDoorLine,
  formatDuration,
  placeActionAccessibleName,
  placeActionDetails,
  placeActionDone,
  placeActionName,
  placeBlockReason,
  placeHoursLine,
} from './placeActionCopy'
import { findPlace, landmarks, venues } from './places'

const plain = { copy: createCopy(baseCopy, { id: 'none', strings: {} }) }
const nyc = { copy: createCopy(baseCopy, slangPacks.nyc ?? { id: 'none', strings: {} }) }

function snapshotAt(
  clock: string,
  overrides: { clout?: number; cash?: number } = {},
): GameSnapshot {
  const [h = 0, m = 0] = clock.split(':').map(Number)
  const base = initialSnapshot(engineConfig)
  const snapshot = {
    clock: { minute: h * 60 + m, remainderMs: 0 },
    player: { ...base.player, cash: overrides.cash ?? 150 },
  }
  return withClout(snapshot, overrides.clout ?? 0, engineConfig)
}

function place(id: string) {
  const found = findPlace(id)
  if (found === undefined) throw new Error(`no place ${id}`)
  return found
}

function actionAt(id: string, actionId: string, snapshot: GameSnapshot): PlaceAction {
  const view = placeActions(place(id), snapshot, engineConfig)
  const found = view.kind === 'actions' ? view.actions.find((a) => a.id === actionId) : undefined
  if (found === undefined) throw new Error(`no ${actionId} at ${id}`)
  return found
}

describe('formatDuration', () => {
  it.each([
    [15, '15 min'],
    [60, '1 h'],
    [240, '4 h'],
    [90, '1 h 30 min'],
  ])('%i minutes reads %s', (minutes, text) => {
    expect(formatDuration(minutes, plain)).toBe(text)
  })
})

describe('place action labels', () => {
  it('names the duration, price and gain with the shared money formatter', () => {
    const coffee = actionAt('steam-vent-coffee', 'coffee', snapshotAt('08:00'))
    const name = placeActionAccessibleName(
      coffee,
      place('steam-vent-coffee'),
      snapshotAt('08:00'),
      plain,
    )
    expect(name).toContain('Coffee: ')
    expect(name).toContain(formatMoney(coffee.def.cashCost))
  })

  it('a club night shows its cover and clout gain', () => {
    const night = snapshotAt('23:00', { clout: 100 })
    const action = actionAt('glowmatic', 'club-night', night)
    const details = placeActionDetails(action, night, plain)
    expect(details).toContain(
      `${formatMoney(engineConfig.place.clubs.glowmatic?.coverCharge ?? 0)} cover`,
    )
    expect(details).toMatch(/\+\d+ clout/)
  })

  it('a blocked action carries its reason in the accessible name', () => {
    const day = snapshotAt('12:00')
    const action = actionAt('glowmatic', 'club-night', day)
    const name = placeActionAccessibleName(action, place('glowmatic'), day, plain)
    expect(name).toMatch(/^Go in: .+\. Closed\. Opens at 22:00\.$/)
  })

  it('the club door refusal is in voice in the nyc pack and names the levels', () => {
    const night = snapshotAt('23:00')
    const action = actionAt('glowmatic', 'club-night', night)
    if (action.block === null) throw new Error('expected the door to refuse')
    const reason = placeBlockReason(action.block, place('glowmatic'), nyc)
    expect(reason).toContain('Bouncer checked the list')
    expect(reason).toContain('Local')
    expect(reason).toContain('Nobody')
  })

  it('a locked borough reason comes from the borough copy', () => {
    const action = actionAt('brickwave', 'club-night', snapshotAt('23:00'))
    if (action.block === null) throw new Error('expected a lock')
    expect(placeBlockReason(action.block, place('brickwave'), plain)).toMatch(/Brooklyn is locked/)
  })

  it('reports opening hours on the personal clock', () => {
    expect(placeHoursLine({ status: 'always' }, plain)).toBe('Open 24 hours')
    expect(placeHoursLine({ status: 'open', closesAt: '19:00' }, plain)).toBe('Open until 19:00')
    expect(placeHoursLine({ status: 'closed', opensAt: '22:00' }, plain)).toBe(
      'Closed. Opens at 22:00.',
    )
  })

  it('renders a label for every action at every real place without throwing', () => {
    for (const snapshot of [snapshotAt('08:00'), snapshotAt('23:00', { clout: 5000, cash: 0 })]) {
      for (const entry of [...venues, ...landmarks]) {
        const view = placeActions(entry, snapshot, engineConfig)
        if (view.kind !== 'actions') continue
        for (const action of view.actions) {
          for (const options of [plain, nyc]) {
            expect(placeActionAccessibleName(action, entry, snapshot, options)).not.toMatch(/[{}]/)
          }
        }
      }
    }
  })
})

describe('placeActionDone', () => {
  it('a visit names the place and the mood gain', () => {
    const result = performPlaceAction(
      snapshotAt('10:00'),
      place('flushing-meadows'),
      'visit',
      engineConfig,
    )
    if (!result.ok) throw new Error(result.error.code)
    expect(placeActionDone(result, place('flushing-meadows'), plain)).toMatch(
      /^You visited Flushing Meadows.*: \+\d+ mood\.$/,
    )
  })

  it('a club night reports the clout gain', () => {
    const result = performPlaceAction(
      snapshotAt('23:00', { clout: 100 }),
      place('glowmatic'),
      'club-night',
      engineConfig,
    )
    if (!result.ok) throw new Error(result.error.code)
    expect(placeActionDone(result, place('glowmatic'), plain)).toMatch(/\+\d+ clout\.$/)
  })
})

describe('a repeat club entry the same night (orchestrator ruling, S09)', () => {
  const night = snapshotAt('23:00', { clout: 100 })
  const first = performPlaceAction(night, place('glowmatic'), 'club-night', engineConfig)
  if (!first.ok) throw new Error(first.error.code)
  const repeat = performPlaceAction(first.snapshot, place('glowmatic'), 'club-night', engineConfig)
  if (!repeat.ok) throw new Error(repeat.error.code)

  it('says so in voice and in plain copy, with no clout in the effects', () => {
    expect(placeActionDone(repeat, place('glowmatic'), nyc)).toMatch(
      /^Back again\? You already made your name here tonight, so no extra clout\. \+\d+ mood\.$/,
    )
    expect(placeActionDone(repeat, place('glowmatic'), plain)).toMatch(
      /^You're in\. You already earned clout here tonight, so this visit adds none: \+\d+ mood\.$/,
    )
  })

  it('the button details say clout is already earned tonight', () => {
    const action = actionAt('glowmatic', 'club-night', repeat.snapshot)
    expect(placeActionDetails(action, repeat.snapshot, plain)).toMatch(
      /cover, \d+ energy, \+\d+ mood, clout already earned here tonight$/,
    )
  })
})

describe('flex copy (S13)', () => {
  const { flex } = engineConfig.clout

  it('the button is plain: "Flex", its time, energy and clout', () => {
    const action = actionAt('queens-ballpark', 'flex', snapshotAt('12:00'))
    expect(placeActionName(action, plain)).toBe('Flex')
    expect(placeActionDetails(action, snapshotAt('12:00'), plain)).toBe(
      `${flex.durationMin} min, ${flex.energyCost} energy, +${Math.floor(flex.baseClout * 1.25)} clout`,
    )
  })

  it('a used-up flex names why in the accessible name', () => {
    const snapshot = snapshotAt('12:00')
    const done = performPlaceAction(snapshot, place('queens-ballpark'), 'flex', engineConfig)
    if (!done.ok) throw new Error(done.error.code)
    const again = actionAt('queens-ballpark', 'flex', done.snapshot)
    expect(placeActionAccessibleName(again, place('queens-ballpark'), done.snapshot, plain)).toBe(
      `Flex: ${placeActionDetails(again, done.snapshot, plain)}. You already flexed here today. Try another spot.`,
    )
    expect(
      placeBlockReason(
        { code: 'flex-daily-limit', max: flex.maxPerGameDay },
        place('dumbo'),
        plain,
      ),
    ).toBe(`You've flexed ${flex.maxPerGameDay} times today, the daily limit. Come back tomorrow.`)
  })

  it('the result is in voice, viral or not, with the clout earned', () => {
    const snapshot = snapshotAt('12:00')
    const done = performPlaceAction(snapshot, place('queens-ballpark'), 'flex', engineConfig)
    if (!done.ok) throw new Error(done.error.code)
    const text = placeActionDone(done, place('queens-ballpark'), nyc)
    expect(text).toMatch(
      done.flex?.viral === true
        ? /^Gone viral\. The whole city's reposting\. \+\d+ clout$/
        : /^.+ in broad daylight\. The algorithm is about to eat\. \+\d+ clout$/,
    )
    expect(text).toContain(`+${done.cloutGained} clout`)
    const viral = { ...done, flex: { viral: true, chance: 0.1 } }
    expect(placeActionDone(viral, place('queens-ballpark'), plain)).toBe(
      `Your flex went viral: +${done.cloutGained} clout.`,
    )
  })
})

describe('flex copy names the light it was posted in (S04f keyframes)', () => {
  it.each([
    ['06:00', 'at sunrise'],
    ['08:00', 'in the morning light'],
    ['12:00', 'in broad daylight'],
    ['17:45', 'at golden hour'],
    ['19:15', 'at dusk'],
    ['22:00', 'after dark'],
    ['02:00', 'after dark'],
  ])('a flex started at %s says "%s"', (clock, phrase) => {
    const done = performPlaceAction(
      snapshotAt(clock),
      place('queens-ballpark'),
      'flex',
      engineConfig,
    )
    if (!done.ok) throw new Error(done.error.code)
    const normal = { ...done, flex: { viral: false, chance: 0.1 } }
    expect(placeActionDone(normal, place('queens-ballpark'), nyc)).toBe(
      `Queens ballpark ${phrase}. The algorithm is about to eat. +${done.cloutGained} clout`,
    )
    expect(placeActionDone(normal, place('queens-ballpark'), plain)).toBe(
      `You flexed at Queens ballpark ${phrase}: +${done.cloutGained} clout.`,
    )
  })
})

describe('plain numbers on every row', () => {
  it('a shift shows its time, energy cost and pay, and never "free"', () => {
    const snapshot = snapshotAt('09:00')
    const action = actionAt('steam-vent-coffee', 'shift-barista', snapshot)
    const { shiftHours, energyCostPerShift, hourlyWage } = engineConfig.jobs
    expect(placeActionDetails(action, snapshot, plain)).toBe(
      `${shiftHours} h, ${energyCostPerShift.barista} energy, ${formatMoney(hourlyWage.barista * shiftHours)} pay`,
    )
    for (const job of ['barista', 'retail', 'delivery'] as const) {
      expect(energyCostPerShift[job]).toBeGreaterThan(0)
    }
  })

  it('no row anywhere says "free"', () => {
    for (const entry of [...venues, ...landmarks]) {
      const snapshot = snapshotAt('12:00', { clout: 5000 })
      const view = placeActions(entry, snapshot, engineConfig)
      if (view.kind !== 'actions') continue
      for (const action of view.actions) {
        expect(placeActionDetails(action, snapshot, plain), `${entry.id} ${action.id}`).not.toMatch(
          /free/i,
        )
      }
    }
  })

  it('a too-tired shift points to sleep', () => {
    const tired = { ...snapshotAt('09:00') }
    const drained = {
      ...tired,
      player: { ...tired.player, stats: { ...tired.player.stats, energy: 5 } },
    }
    const shift = actionAt('steam-vent-coffee', 'shift-barista', drained)
    expect(shift.block?.code).toBe('energy')
    expect(placeBlockReason(shift.block!, place('steam-vent-coffee'), plain, shift)).toBe(
      `You need ${engineConfig.jobs.energyCostPerShift.barista} energy. You have 5. Head home and sleep to get it back.`,
    )
  })
})

describe('a meal result says what really landed (GR-11)', () => {
  it('breakfast eaten nearly full reports the capped fullness, not the menu number', () => {
    const base = snapshotAt('08:00')
    const full = {
      ...base,
      player: { ...base.player, stats: { ...base.player.stats, hunger: 90 } },
    }
    const done = performPlaceAction(
      full,
      place('late-lantern-deli'),
      'bodega-breakfast',
      engineConfig,
    )
    if (!done.ok) throw new Error(done.error.code)
    const landed = done.snapshot.player.stats.hunger
    const before = landed - (done.statEffects.hunger ?? 0)
    expect(landed).toBe(engineConfig.stats.max)
    expect(done.statEffects.hunger).toBeLessThan(40)
    expect(before).toBeGreaterThan(0)
    expect(placeActionDone(done, place('late-lantern-deli'), plain)).toContain(
      `+${done.statEffects.hunger} fullness`,
    )
    expect(placeActionDone(done, place('late-lantern-deli'), plain)).not.toContain('+40 fullness')
  })
})

describe('home actions copy (B1)', () => {
  const home = (snapshot: GameSnapshot) => homeActions(snapshot, engineConfig)

  it('names sleep, nap and the home meal with plain numbers from config', () => {
    const snapshot = snapshotAt('22:00')
    const [sleep, nap, meal] = home(snapshot)
    const { catalog } = engineConfig.actions
    expect(sleep && placeActionName(sleep, plain)).toBe('Sleep')
    expect(nap && placeActionName(nap, plain)).toBe('Nap')
    expect(meal && placeActionName(meal, plain)).toBe('Cook at home')
    expect(sleep && placeActionDetails(sleep, snapshot, plain)).toBe(
      `${(catalog.sleep?.durationMin ?? 0) / 60} h, +${catalog.sleep?.statEffects.energy} energy, +${catalog.sleep?.statEffects.mood} mood`,
    )
    expect(meal && placeActionDetails(meal, snapshot, plain)).toBe(
      `${catalog['home-meal']?.durationMin} min, ${formatMoney(catalog['home-meal']?.cashCost ?? 0)}, ${catalog['home-meal']?.energyCost} energy, +${catalog['home-meal']?.statEffects.hunger} fullness`,
    )
  })

  it('away from home, each says to head home first', () => {
    const away = { ...snapshotAt('22:00') }
    const out = {
      ...away,
      player: { ...away.player, location: { kind: 'place', placeId: 'glowmatic' } as const },
    }
    for (const action of home(out)) {
      expect(action.block?.code).toBe('away')
      expect(placeActionAccessibleName(action, null, out, plain)).toMatch(
        /\. You're not home\. Head home first\.$/,
      )
    }
  })

  it('a sleep result reports the energy it really gave', () => {
    const snapshot = snapshotAt('22:00')
    const done = performHomeAction(snapshot, 'sleep', engineConfig)
    if (!done.ok) throw new Error(done.error.code)
    expect(placeActionDone(done, null, plain)).toMatch(/^Done: \+\d+ energy(, \+\d+ mood)?\.$/)
  })
})

describe('club door line (before travel)', () => {
  it('says the level the door lets in and where the player is', () => {
    const snapshot = snapshotAt('12:00')
    const view = placeActions(place('glowmatic'), snapshot, engineConfig)
    if (view.kind !== 'actions' || view.door === null) throw new Error('no door')
    expect(view.door).toEqual({ requiredLevel: 'local', met: false })
    expect(clubDoorLine(view.door, snapshot, plain)).toBe(
      "Door: Local clout and up. You're at Nobody.",
    )
    const local = snapshotAt('12:00', { clout: 100 })
    const open = placeActions(place('glowmatic'), local, engineConfig)
    expect(open.kind === 'actions' && open.door).toEqual({ requiredLevel: 'local', met: true })
    const deli = placeActions(place('late-lantern-deli'), snapshot, engineConfig)
    expect(deli.kind === 'actions' && deli.door).toBeNull()
  })
})
