/**
 * Whether the map is playable (S05b): the scene has drawn, or failed and left the Places panel
 * as the way to play. Audio waits for it so sound never competes with the map for bandwidth
 * (CLAUDE.md "Performance budgets": audio is excluded from the bytes to playable).
 *
 * The 3D scene's mount (src/scene/CitySceneClient.tsx) marks it when the first frame has drawn
 * or the scene has failed (no WebGL, or the geo or 3D chunk could not load).
 */

export interface MapPlayableSignal {
  markMapPlayable(): void
  isMapPlayable(): boolean
  /** Resolves once the map is playable (at once if it already is). */
  whenMapPlayable(): Promise<void>
}

export function createMapPlayableSignal(): MapPlayableSignal {
  let playable = false
  let resolve: () => void = () => undefined
  const ready = new Promise<void>((done) => {
    resolve = done
  })
  return {
    markMapPlayable: () => {
      playable = true
      resolve()
    },
    isMapPlayable: () => playable,
    whenMapPlayable: () => ready,
  }
}

const signal = createMapPlayableSignal()

export const markMapPlayable = signal.markMapPlayable
export const isMapPlayable = signal.isMapPlayable
export const whenMapPlayable = signal.whenMapPlayable
