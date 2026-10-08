/**
 * A tap on the 3D map (S04c): one primary pointer, primary button, released within `maxMs` and
 * no more than `slopPx` from where it went down. Anything else (a pan, a pinch, a long press, a
 * second finger) is the camera's, so picking a place never fights the map controls. Listens on
 * the canvas element directly instead of R3F's onClick, which raycasts every pointer event.
 */
export interface TapOptions {
  readonly slopPx: number
  readonly maxMs: number
}

/** The PointerEvent fields the detector reads (a structural type, so tests need no DOM). */
export interface TapPointerEvent {
  readonly pointerId: number
  readonly isPrimary: boolean
  readonly button: number
  readonly clientX: number
  readonly clientY: number
  readonly timeStamp: number
}

export interface TapTarget {
  addEventListener(type: string, listener: (event: TapPointerEvent) => void): void
  removeEventListener(type: string, listener: (event: TapPointerEvent) => void): void
}

/** Calls `onTap` with the client coordinates of each tap. Returns the detach function. */
export function attachTapDetector(
  target: TapTarget,
  { slopPx, maxMs }: TapOptions,
  onTap: (x: number, y: number) => void,
): () => void {
  const down = new Set<number>()
  let candidate: { id: number; x: number; y: number; at: number } | null = null

  const moved = (event: TapPointerEvent) =>
    candidate !== null &&
    Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > slopPx

  const onDown = (event: TapPointerEvent) => {
    down.add(event.pointerId)
    candidate =
      down.size === 1 && event.isPrimary && event.button === 0
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp }
        : null
  }
  const onMove = (event: TapPointerEvent) => {
    if (candidate?.id === event.pointerId && moved(event)) candidate = null
  }
  const onUp = (event: TapPointerEvent) => {
    down.delete(event.pointerId)
    const tap = candidate
    if (tap === null || tap.id !== event.pointerId) return
    const isTap = !moved(event) && event.timeStamp - tap.at <= maxMs
    candidate = null
    if (isTap) onTap(event.clientX, event.clientY)
  }
  const onCancel = (event: TapPointerEvent) => {
    down.delete(event.pointerId)
    if (candidate?.id === event.pointerId) candidate = null
  }

  const listeners: [string, (event: TapPointerEvent) => void][] = [
    ['pointerdown', onDown],
    ['pointermove', onMove],
    ['pointerup', onUp],
    ['pointercancel', onCancel],
  ]
  for (const [type, listener] of listeners) target.addEventListener(type, listener)
  return () => {
    for (const [type, listener] of listeners) target.removeEventListener(type, listener)
  }
}
