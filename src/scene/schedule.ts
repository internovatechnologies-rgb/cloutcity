/**
 * Main-thread scheduling for the 3D map's start-up (S04b, PERF-4). Starting the map is the
 * heaviest work on the page; these let it wait for, and give back, the main thread so the shell
 * and the other islands stay responsive while it starts.
 */

interface IdleWindow {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

/**
 * Runs `callback` once the main thread is idle, or after `timeoutMs` at the latest. Browsers
 * without requestIdleCallback (Safari) get a timer instead. Returns a cancel function.
 */
export function whenIdle(callback: () => void, timeoutMs: number): () => void {
  const idle = window as Window & IdleWindow
  if (typeof idle.requestIdleCallback === 'function') {
    const handle = idle.requestIdleCallback(callback, { timeout: timeoutMs })
    return () => idle.cancelIdleCallback?.(handle)
  }
  const handle = window.setTimeout(callback, 0)
  return () => window.clearTimeout(handle)
}

interface YieldScheduler {
  yield?: () => Promise<void>
}

/**
 * Gives the browser a turn (input, rendering, other tasks) and resolves after it, at the front
 * of the queue where `scheduler.yield()` exists (Chromium) and as a new task otherwise. A
 * MessageChannel message is a task without setTimeout's clamping to 4 ms.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (window as Window & { scheduler?: YieldScheduler }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/**
 * A cooperative time slicer for long builds (S04d, S07a): call the returned function between
 * small units of work; it resolves at once while the current slice is under `sliceMs` and
 * otherwise gives the browser a turn (`yieldFn`, yieldToMain by default) and starts a new slice.
 */
export function createSlicer(
  sliceMs: number,
  yieldFn: () => Promise<void> = yieldToMain,
  now: () => number = () => performance.now(),
): () => Promise<void> {
  let start = now()
  return async () => {
    if (now() - start < sliceMs) return
    await yieldFn()
    start = now()
  }
}
