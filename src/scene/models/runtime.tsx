'use client'

/**
 * The model runtime's React side (S04h): one provider per canvas holds the quality tier and the
 * shared model material; `useModels` takes references on models in the page-wide cache
 * (cache.ts: refcount + LRU sized by scene.json `models.cacheMaxEntries`) for as long as the
 * component is mounted. Loading is lazy: nothing here runs until a model component mounts, and
 * this module only ever ships in lazy chunks (the 3D chunk, the showcase).
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { DataTexture, Material } from 'three'
import { log } from '@/lib/log'
import { createRefCountLru, type RefCountLru } from './cache'
import { useNightGlow } from '../lighting/nightGlow'
import { createModelMaterial } from './materials'
import { disposeModel, loadModel, type LoadedModel } from './prepare'
import type { ModelRef, ModelsConfig, ModelTier } from './types'

interface ModelsContextValue {
  readonly config: ModelsConfig
  readonly tier: ModelTier
  readonly material: Material
}

const ModelsContext = createContext<ModelsContextValue | null>(null)

let cache: RefCountLru<LoadedModel> | undefined

function modelCache(maxIdle: number): RefCountLru<LoadedModel> {
  cache ??= createRefCountLru(maxIdle, disposeModel)
  return cache
}

/**
 * References `refs` at `tier` outside React (scene graphs built imperatively, like the
 * apartment). The caller must call `release` exactly once, whether or not the load succeeded.
 */
export function acquireModels(
  refs: readonly ModelRef[],
  tier: ModelTier,
  maxIdle: number,
): { readonly models: Promise<LoadedModel[]>; release(): void } {
  const store = modelCache(maxIdle)
  const files = refs.map((ref) => ref.files[tier])
  const models = Promise.all(
    refs.map((ref, i) => {
      const file = files[i] ?? ref.files[tier]
      return store.acquire(file, () => loadModel(ref, file))
    }),
  )
  let released = false
  return {
    models,
    release() {
      if (released) return
      released = true
      for (const file of files) store.release(file)
    },
  }
}

/** Cache counters for the showcase test hook. */
export function modelCacheStats(): { readonly held: number; readonly idle: number } {
  return cache?.stats() ?? { held: 0, idle: 0 }
}

export function ModelsProvider({
  config,
  tier,
  gradientMap,
  children,
}: {
  readonly config: ModelsConfig
  readonly tier: ModelTier
  readonly gradientMap?: DataTexture
  readonly children: ReactNode
}) {
  // The shared uNightGlow (S04f): the day/night rig writes it, every model material reads it.
  const nightGlow = useNightGlow()
  const material = useMemo(
    () => createModelMaterial({ config, tier, gradientMap, nightGlow }),
    [config, tier, gradientMap, nightGlow],
  )
  useEffect(() => () => material.dispose(), [material])
  const value = useMemo(() => ({ config, tier, material }), [config, tier, material])
  return <ModelsContext value={value}>{children}</ModelsContext>
}

export function useModelsContext(): ModelsContextValue {
  const value = useContext(ModelsContext)
  if (value === null) throw new Error('Model components must sit inside <ModelsProvider>')
  return value
}

export type ModelsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly models: readonly LoadedModel[] }
  | { readonly status: 'error' }

/**
 * References `refs` (at the provider's tier) while mounted. A failed download or decode is an
 * expected condition (offline: model files are not precached; a stale deploy), so it logs at
 * info, like other expected scene conditions, and reports `error`; the caller keeps its fallback.
 */
export function useModels(refs: readonly ModelRef[]): ModelsState {
  const { config, tier } = useModelsContext()
  const files = refs.map((ref) => ref.files[tier])
  const key = files.join('|')
  const [state, setState] = useState<{ key: string; value: ModelsState }>({
    key,
    value: { status: 'loading' },
  })

  useEffect(() => {
    const store = modelCache(config.cacheMaxEntries)
    let active = true
    const acquired = refs.map((ref) => {
      const file = ref.files[tier]
      return { file, promise: store.acquire(file, () => loadModel(ref, file)) }
    })
    Promise.all(acquired.map((entry) => entry.promise)).then(
      (models) => {
        if (active) setState({ key, value: { status: 'ready', models } })
      },
      (error: unknown) => {
        if (!active) return
        log.info('model load failed', {
          files: acquired.map((entry) => entry.file),
          error: error instanceof Error ? error.message : String(error),
        })
        setState({ key, value: { status: 'error' } })
      },
    )
    return () => {
      active = false
      for (const entry of acquired) {
        // A failed load has already left the cache; releasing it again is a no-op.
        store.release(entry.file)
      }
    }
    // `key` covers `refs` and `tier`: the refs array itself is usually rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, config.cacheMaxEntries])

  return state.key === key ? state.value : { status: 'loading' }
}
