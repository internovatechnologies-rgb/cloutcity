/**
 * The transit world for trips (S08 part 2): the subway graph, the land mask and the taxi
 * crossings, built once per session from the geo layers (src/state/geoSource.ts). Part of the
 * travel chunk: the shell starts it when the browser is idle after the map is playable
 * (src/scene/CitySceneClient.tsx), so the first "Get there" rows are usually ready when a
 * place opens; the place sheet starts it too if it is still missing.
 *
 * A failed load is an expected condition (offline before the geo was cached, a bad deploy): it
 * is logged at info, the status says `failed`, trips fall back to a straight taxi estimate
 * (src/engine/transit/trip.ts `planDirect`), and `retryTransitWorld` tries again.
 */
import { createStore } from 'zustand/vanilla'
import { transitConfig } from '@/engine/transit/config'
import { buildTransitWorld, type TransitWorld } from '@/engine/transit/world'
import { log } from '@/lib/log'
import { loadTransitGeo } from './geoSource'

export type TransitWorldStatus = 'idle' | 'loading' | 'ready' | 'failed'

interface TransitWorldState {
  readonly status: TransitWorldStatus
  readonly world: TransitWorld | null
}

export const transitWorldStore = createStore<TransitWorldState>()(() => ({
  status: 'idle',
  world: null,
}))

let pending: Promise<TransitWorld | null> | null = null

/** A macrotask: building the graph is a long task, so let the page breathe first. */
const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function build(): Promise<TransitWorld | null> {
  transitWorldStore.setState({ status: 'loading' })
  const geo = await loadTransitGeo()
  if (!geo.ok) {
    log.info('Transit routes are unavailable; trips fall back to a taxi estimate', {
      ...geo.failure,
    })
    transitWorldStore.setState({ status: 'failed', world: null })
    return null
  }
  await yieldToMain()
  try {
    const world = buildTransitWorld({ subway: geo.subway, land: geo.land }, transitConfig)
    transitWorldStore.setState({ status: 'ready', world })
    return world
  } catch (error) {
    // Validated data that still cannot build a graph is a bug; trips still work as estimates.
    log.error('Could not build the transit world', {
      error: error instanceof Error ? error.message : String(error),
    })
    transitWorldStore.setState({ status: 'failed', world: null })
    return null
  }
}

/** Builds the world once (later calls share the first build); resolves null when it failed. */
export function ensureTransitWorld(): Promise<TransitWorld | null> {
  pending ??= build()
  return pending
}

/** Tries again after a failure (the Retry in the "Get there" section). */
export function retryTransitWorld(): Promise<TransitWorld | null> {
  if (transitWorldStore.getState().status === 'failed') pending = null
  return ensureTransitWorld()
}
