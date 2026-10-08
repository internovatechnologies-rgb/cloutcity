/**
 * Reference-counted cache with a bounded LRU of idle entries (S04h). Every mounted user of a
 * model holds a reference; when the last one releases it the decoded model stays in memory as
 * an idle entry, so remounting (a sheet closing and reopening, the apartment re-entered) does
 * not re-download or re-decode it. Only idle entries are evicted, oldest first, once there are
 * more than `maxIdle`, and an evicted entry is disposed (its GPU buffers freed). A failed load
 * is dropped at once, so the next acquire retries.
 */

interface Entry<T> {
  readonly promise: Promise<T>
  value: T | undefined
  refs: number
}

export interface RefCountLru<T> {
  /** Takes a reference to `key`, loading it on first use. */
  acquire(key: string, load: () => Promise<T>): Promise<T>
  /** Gives one reference back; the entry becomes idle (evictable) at zero. */
  release(key: string): void
  /** Disposes every loaded entry and forgets them all. */
  clear(): void
  /** Entries held or idle, for tests and the showcase hook. */
  stats(): { readonly held: number; readonly idle: number }
}

export function createRefCountLru<T>(maxIdle: number, dispose: (value: T) => void): RefCountLru<T> {
  if (!Number.isInteger(maxIdle) || maxIdle < 0) throw new Error('maxIdle must be an integer >= 0')
  const entries = new Map<string, Entry<T>>()
  // Insertion order is recency: a key is re-inserted whenever it becomes idle.
  const idle = new Set<string>()

  const evict = () => {
    while (idle.size > maxIdle) {
      const oldest = idle.values().next().value
      if (oldest === undefined) return
      idle.delete(oldest)
      const entry = entries.get(oldest)
      entries.delete(oldest)
      if (entry?.value !== undefined) dispose(entry.value)
    }
  }

  return {
    acquire(key, load) {
      const existing = entries.get(key)
      if (existing !== undefined) {
        existing.refs += 1
        idle.delete(key)
        return existing.promise
      }
      const entry: Entry<T> = {
        refs: 1,
        value: undefined,
        promise: load().then(
          (value) => {
            // Cleared or evicted while loading: nobody can release it any more, so free it now.
            if (entries.get(key) !== entry) dispose(value)
            else entry.value = value
            return value
          },
          (error: unknown) => {
            if (entries.get(key) === entry) {
              entries.delete(key)
              idle.delete(key)
            }
            throw error
          },
        ),
      }
      entries.set(key, entry)
      return entry.promise
    },
    release(key) {
      const entry = entries.get(key)
      if (entry === undefined || entry.refs === 0) return
      entry.refs -= 1
      if (entry.refs > 0) return
      idle.add(key)
      evict()
    },
    clear() {
      for (const entry of entries.values()) {
        if (entry.value !== undefined) dispose(entry.value)
      }
      entries.clear()
      idle.clear()
    },
    stats() {
      return { held: entries.size - idle.size, idle: idle.size }
    },
  }
}
