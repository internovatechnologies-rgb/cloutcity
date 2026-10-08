import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

// S04c helpers: copy and place data as players see them, and the scene hook's pins.

const ROOT = join(import.meta.dirname, '../../..')
export const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as T

/** A copy string as players see it: the active slang pack over base (src/lib/copy). */
export function copyText(key: string, vars: Readonly<Record<string, string>> = {}): string {
  const { slangPack } = readJson<{ slangPack: string }>('data/config/copy.json')
  const dir = `data/copy/${key.split('.')[0]}`
  const pack = existsSync(join(ROOT, dir, `${slangPack}.json`))
    ? readJson<{ strings: Record<string, string> }>(`${dir}/${slangPack}.json`)
    : { strings: {} as Record<string, string> }
  const base = readJson<{ strings: Record<string, string> }>(`${dir}/base.json`)
  const text = pack.strings[key] ?? base.strings[key]
  if (text === undefined) throw new Error(`no copy for ${key}`)
  return text.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`no value for {${name}} in ${key}`)
    return value
  })
}

interface PlaceData {
  readonly id: string
  readonly nameKey: string
  readonly borough: string
  readonly category?: string
}

export const venues = readJson<{ venues: PlaceData[] }>('data/venues/venues.json').venues
export const landmarks = readJson<{ landmarks: PlaceData[] }>(
  'data/landmarks/landmarks.json',
).landmarks
/** Every place, venues first, as the panel and the pins list them. */
export const places: readonly PlaceData[] = [...venues, ...landmarks]
export const boroughs = readJson<{
  boroughs: { id: string; nameKey: string; teaserLandmarkIds: string[] }[]
}>('data/boroughs/boroughs.json').boroughs

export function placeName(id: string): string {
  const place = places.find((candidate) => candidate.id === id)
  if (place === undefined) throw new Error(`no place ${id}`)
  return copyText(place.nameKey)
}

export interface HookPin {
  readonly id: string
  readonly kind: string
  readonly style: string
  readonly borough: string
  readonly screen: { readonly x: number; readonly y: number } | null
}

export const scenePins = (page: Page): Promise<HookPin[]> =>
  page.evaluate(() => window.__cloutcityTest?.scene?.pins() ?? [])

/** data/config/scene.json pin picking settings. */
export const pinConfig = readJson<{ pins: { hitRadiusPx: number; ambiguityPx: number } }>(
  'data/config/scene.json',
).pins

/** Whether a client point lands on the 3D canvas itself (nothing over it catches the tap). */
export const hitsCanvas = (page: Page, point: { x: number; y: number }): Promise<boolean> =>
  page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.matches('[data-scene-root] canvas') ?? false,
    point,
  )
