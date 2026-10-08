/**
 * Player-facing text for a level-up (S13): the level reached, its in-voice message and what it
 * unlocked, built from the engine's `LevelUp` through the copy layer.
 */
import type { LevelUp } from '@/engine/clout'
import { copy as activeCopy, isCopyKey, type CopyFn, type CopyKey } from './copy'
import { cloutLevelName, jobName } from './economyCopy'
import { boroughs, findPlace, placeName } from './world/places'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/boroughs'
import '@/lib/copy/ns/clout'

export interface LevelUpCopyOptions {
  readonly copy?: CopyFn
}

function requireKey(key: string, what: string): CopyKey {
  if (!isCopyKey(key)) throw new Error(`No copy key "${key}" for ${what}`)
  return key as CopyKey
}

/** `scene-regular` → `sceneRegular`, the copy-key segment for a kebab-case id. */
function camelSegment(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, next: string) => next.toUpperCase())
}

/** "New level: Local". */
export function levelUpTitle(levelUp: LevelUp, options: LevelUpCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('clout.levelUp.title', { level: cloutLevelName(levelUp.to, options) })
}

/** The level's own message, e.g. "Your name's starting to ring. Brooklyn noticed." */
export function levelUpMessage(levelUp: LevelUp, options: LevelUpCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy(requireKey(`clout.levelUp.${camelSegment(levelUp.to)}`, `level ${levelUp.to}`))
}

/** "Unlocked: Brooklyn, Junior dev, Glowmatic", or null when the level unlocked nothing. */
export function levelUpUnlocked(levelUp: LevelUp, options: LevelUpCopyOptions = {}): string | null {
  const { copy = activeCopy } = options
  const names = [
    ...levelUp.unlocks.boroughs.map((id) => {
      const entry = boroughs.find((borough) => borough.id === id)
      if (entry === undefined) throw new Error(`data/boroughs has no borough "${id}"`)
      return copy(requireKey(entry.nameKey, `borough ${id}`))
    }),
    ...levelUp.unlocks.jobs.map((id) => jobName(id, options)),
    ...levelUp.unlocks.clubs.map((id) => {
      const place = findPlace(id)
      if (place === undefined) throw new Error(`No place "${id}" for an unlocked club`)
      return placeName(place, options)
    }),
  ]
  return names.length === 0 ? null : copy('clout.levelUp.unlocked', { list: names.join(', ') })
}

/** The close button's accessible name: "Close the Local message". */
export function levelUpCloseLabel(levelUp: LevelUp, options: LevelUpCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('clout.levelUp.closeLabel', { level: cloutLevelName(levelUp.to, options) })
}
