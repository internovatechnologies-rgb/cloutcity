/**
 * S08 part 2: the trip presentation store, and the import-graph guard that keeps the transit
 * engine (and its geo data) out of the game store and the shell: it loads only with the travel
 * chunk (DEC-11).
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { venues, landmarks } from '@/lib/world/places'
import { SRC, rel, staticClosure } from '@/lib/testing/importGraph'
import {
  HOME_SPOT_ID,
  dismissArrival,
  setPlayerSpot,
  spotId,
  tripClockMinute,
  tripStore,
  type ActiveTrip,
} from './trip'

const trip = (departMinute: number, arriveMinute: number): ActiveTrip => ({
  id: 1,
  destination: { kind: 'place', placeId: 'late-lantern-deli' },
  mode: 'walk',
  route: {
    mode: 'walk',
    from: { x: 0, y: 0 },
    to: { x: 1, y: 1 },
    legs: [],
    durationMin: arriveMinute - departMinute,
    fare: 0,
    transfers: 0,
    walkedM: 0,
    rushHour: false,
  },
  departMinute,
  arriveMinute,
  durationMs: 3000,
  startedAtMs: 0,
})

describe('trip store', () => {
  it('the HUD clock counts up from departure to arrival with the animation', () => {
    expect(tripClockMinute({ active: null, progress: 0.5 })).toBeNull()
    const active = trip(600, 640)
    expect(tripClockMinute({ active, progress: 0 })).toBe(600)
    expect(tripClockMinute({ active, progress: 0.5 })).toBe(620)
    expect(tripClockMinute({ active, progress: 1 })).toBe(640)
    expect(tripClockMinute({ active, progress: 7 })).toBe(640)
    expect(tripClockMinute({ active, progress: -1 })).toBe(600)
  })

  it('mirrors the spot only when it changes (no needless re-render)', () => {
    setPlayerSpot({ kind: 'home' })
    const first = tripStore.getState().spot
    setPlayerSpot({ kind: 'home' })
    expect(tripStore.getState().spot).toBe(first)
    setPlayerSpot({ kind: 'place', placeId: 'late-lantern-deli' })
    expect(tripStore.getState().spot).toEqual({ kind: 'place', placeId: 'late-lantern-deli' })
  })

  it('a dismissal clears only its own arrival', () => {
    tripStore.setState({
      arrival: {
        id: 7,
        destination: { kind: 'home' },
        mode: 'taxi',
        durationMin: 12,
        fare: 14,
        delayMin: 0,
        rent: [],
        direct: false,
      },
    })
    dismissArrival(6)
    expect(tripStore.getState().arrival?.id).toBe(7)
    dismissArrival(7)
    expect(tripStore.getState().arrival).toBeNull()
  })

  it('`home` is reserved: no venue or landmark may take it', () => {
    expect(spotId({ kind: 'home' })).toBe(HOME_SPOT_ID)
    expect([...venues, ...landmarks].some((place) => place.id === HOME_SPOT_ID)).toBe(false)
  })
})

describe('the transit engine loads with the travel chunk only (import-graph guard)', () => {
  const closureOf = (file: string) => [...staticClosure([join(SRC, file)]).files].map(rel)
  const transit = (path: string) =>
    path.startsWith('src/engine/transit/') ||
    /^src\/state\/(tripDriver|transitWorld|geoSource)\.ts$/.test(path) ||
    path.startsWith('data/geo/')

  it.each([
    'state/store.ts',
    'state/trip.ts',
    'components/places/PlaceSheetMount.tsx',
    'components/places/PlaceSheet.tsx',
    'components/hud/HudLive.tsx',
    'scene/CitySceneClient.tsx',
  ])('%s reaches no transit module statically', (file) => {
    expect(closureOf(file).filter(transit)).toEqual([])
  })

  it('the 3D chunk reaches only the pure timeline (no graph, land or geo data)', () => {
    const reached = closureOf('scene/CityCanvas.tsx').filter(transit)
    expect(reached.sort()).toEqual([
      'src/engine/transit/polyline.ts',
      'src/engine/transit/timeline.ts',
    ])
  })

  it('the travel chunk does hold the engine (self-check)', () => {
    expect(closureOf('state/tripDriver.ts')).toEqual(
      expect.arrayContaining(['src/engine/transit/trip.ts', 'src/state/transitWorld.ts']),
    )
  })
})
