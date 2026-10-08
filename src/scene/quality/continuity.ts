/**
 * The continuous-rendering window of the runtime step-down (S04b). The map renders on demand
 * (`frameloop="demand"`), so FPS means something only while the scene is meant to animate: a
 * gesture on the map, a camera flight, or a trip's animation (S08). Their owners open the window with
 * {@link beginContinuous} and close it with {@link endContinuous}; TierMonitor renders every
 * frame and measures FPS only while it is open (src/scene/quality/TierMonitor.tsx).
 *
 * Each source opens and closes its own entry, so overlapping sources (a flight interrupted by a
 * drag) and repeated calls are safe. Times are `performance.now()` milliseconds.
 */

/** What keeps the scene animating. */
export type ContinuousSource = 'gesture' | 'flight' | 'travel'

const sources = new Set<ContinuousSource>()
let since: number | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Opens the window for `source` (no-op while it is already open for that source). */
export function beginContinuous(source: ContinuousSource, nowMs = performance.now()): void {
  if (sources.has(source)) return
  sources.add(source)
  if (since === null) {
    since = nowMs
    emit()
  }
}

/** Closes `source`'s entry; the window closes with the last one. */
export function endContinuous(source: ContinuousSource): void {
  if (!sources.delete(source) || sources.size > 0) return
  since = null
  emit()
}

/** When the open window began, or null while it is closed. */
export function continuousSince(): number | null {
  return since
}

export function subscribeContinuous(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
