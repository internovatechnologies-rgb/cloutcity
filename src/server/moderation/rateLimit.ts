import 'server-only'
/**
 * A fixed-window rate limiter kept in this server instance's memory, for the /mod sign-in route
 * (S18b). Tradeoff: on a serverless platform each instance counts on its own, so the real limit
 * is `max` per instance; Supabase Auth's own email rate limit backs it up. Keys are hashed IPs
 * only, never emails.
 */
export interface RateLimiter {
  /** Counts one hit for `key`; false when the window's limit is already used up. */
  take(key: string, nowMs: number): boolean
}

export function createRateLimiter(max: number, windowMs: number, maxKeys = 10_000): RateLimiter {
  const windows = new Map<string, { start: number; hits: number }>()
  return {
    take(key, nowMs) {
      const current = windows.get(key)
      if (current === undefined || nowMs - current.start >= windowMs) {
        if (windows.size >= maxKeys) {
          for (const [stale, window] of windows) {
            if (nowMs - window.start >= windowMs) windows.delete(stale)
          }
          // Still full of live windows: refuse rather than grow without bound.
          if (windows.size >= maxKeys) return false
        }
        windows.set(key, { start: nowMs, hits: 1 })
        return true
      }
      if (current.hits >= max) return false
      current.hits += 1
      return true
    },
  }
}
