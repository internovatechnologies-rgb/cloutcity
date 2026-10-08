import type { PersistStorage, StorageValue } from 'zustand/middleware'
import * as z from 'zod/mini'
import { log, type Logger } from '@/lib/log'

/** Where a store persists: `localStorage` in a browser, nothing on the server. */
export function browserLocalStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

const EnvelopeSchema = z.object({ state: z.unknown(), version: z.optional(z.number()) })

const PROBE_KEY = '__cc_storage_probe__'

/**
 * A zustand persist storage that never throws. Private browsing, disabled site data, a full
 * quota or a server render all fall back to an in-memory copy for this page session, so solo
 * play keeps working and nothing crashes; progress then lasts until the tab closes.
 *
 * These are expected, recoverable conditions, so they log at `info`: `warn` is reserved for
 * real failures (and fails the e2e console guard).
 *
 * Only the `{ state, version }` envelope is checked here. The state itself is untrusted and is
 * validated by the store's `merge` before it reaches the app.
 */
export function createSafeJsonStorage<S>(
  getStorage: () => Storage | undefined,
  logger: Logger = log,
): PersistStorage<S> {
  const memory = new Map<string, string>()
  let backing: Storage | undefined
  let resolved = false
  let reported = false

  const fallBack = (reason: string, error?: unknown) => {
    backing = undefined
    if (reported) return
    reported = true
    logger.info('Saving locally is unavailable; progress lasts until this tab closes', {
      reason,
      error: error instanceof Error ? error.name : undefined,
    })
  }

  const storage = (): Storage | undefined => {
    if (resolved) return backing
    resolved = true
    try {
      const candidate = getStorage()
      if (candidate === undefined) return undefined
      candidate.setItem(PROBE_KEY, '1')
      candidate.removeItem(PROBE_KEY)
      backing = candidate
    } catch (error) {
      fallBack('unavailable', error)
    }
    return backing
  }

  const read = (name: string): string | null => {
    const store = storage()
    if (store !== undefined) {
      try {
        return store.getItem(name)
      } catch (error) {
        fallBack('read-failed', error)
      }
    }
    return memory.get(name) ?? null
  }

  return {
    getItem: (name) => {
      const raw = read(name)
      if (raw === null) return null
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        logger.info('Ignoring a saved game that is not valid JSON', { key: name })
        return null
      }
      const envelope = EnvelopeSchema.safeParse(parsed)
      if (!envelope.success) {
        logger.info('Ignoring a saved game with an unknown format', { key: name })
        return null
      }
      // The state is validated by the store's merge; it is not trusted as S.
      return envelope.data as StorageValue<S>
    },
    setItem: (name, value) => {
      const raw = JSON.stringify(value)
      memory.set(name, raw)
      const store = storage()
      if (store === undefined) return
      try {
        store.setItem(name, raw)
      } catch (error) {
        fallBack('write-failed', error)
      }
    },
    removeItem: (name) => {
      memory.delete(name)
      const store = storage()
      if (store === undefined) return
      try {
        store.removeItem(name)
      } catch (error) {
        fallBack('remove-failed', error)
      }
    },
  }
}

/**
 * Blocks every write while storage holds a value from a newer build (`version` above this
 * build's), so an older build never overwrites what a newer one saved. Reads pass through.
 */
export function guardNewerVersion<S>(inner: PersistStorage<S>, version: number): PersistStorage<S> {
  let newerPresent = false
  return {
    getItem: (name) => {
      const value = inner.getItem(name)
      if (value instanceof Promise) return value
      if (value !== null && (value.version ?? 0) > version) newerPresent = true
      return value
    },
    setItem: (name, value) => (newerPresent ? undefined : inner.setItem(name, value)),
    removeItem: (name) => (newerPresent ? undefined : inner.removeItem(name)),
  }
}
