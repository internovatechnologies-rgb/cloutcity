/**
 * Player-facing text for the apartment (S16): slot and colour names, the home score, placing and
 * moving notices, why a home is locked, and the engine's home errors. Built from engine data and
 * data/homes/interiors.json through the copy layer; money goes through `formatMoney` and counts
 * through `formatCount`, never literals.
 *
 * Client code: it reads data/homes/interiors.json directly (validated in
 * src/lib/data/homes-data.test.ts) rather than through the classic-zod loader.
 */
import interiorsJson from '@data/homes/interiors.json'
import { engineConfig, type EngineConfig, type HomeId } from '@/engine/config'
import { homeClout, homeScore, slotsFor, type HomeError, type HomeLock } from '@/engine/home'
import { moveInCost } from '@/engine/housing'
import { findItem, isDecor, type DecorDef, type DecorFit } from '@/engine/items'
import type { PlayerState } from '@/engine/game'
import { rentFor } from '@/engine/rent'
import type { Borough } from '@/lib/data/schemas/content'
import { copy as activeCopy, isCopyKey, type CopyFn, type CopyKey } from './copy'
import { cloutLevelName, homeName } from './economyCopy'
import { formatCount, formatMoney } from './format'
import { itemName } from './shopCopy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/boroughs'
import '@/lib/copy/ns/colors'
import '@/lib/copy/ns/home'
import '@/lib/copy/ns/housing'

export interface HomeCopyOptions {
  readonly copy?: CopyFn
  readonly config?: EngineConfig
}

function requireKey(key: string, what: string): CopyKey {
  if (!isCopyKey(key)) throw new Error(`No copy key "${key}" for ${what}`)
  return key
}

/** `staten-island` → `statenIsland`, the copy-key segment for a kebab-case id. */
function camelSegment(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, next: string) => next.toUpperCase())
}

function decor(itemId: string, config: EngineConfig): DecorDef {
  const found = findItem(itemId, config)
  if (found === undefined || !isDecor(found)) {
    throw new Error(`data/items/items.json has no decor item "${itemId}"`)
  }
  return found
}

const KIND_KEYS = {
  wall: { title: 'home.kind.wall', lower: 'home.kind.wall.lower' },
  floor: { title: 'home.kind.floor', lower: 'home.kind.floor.lower' },
  surface: { title: 'home.kind.surface', lower: 'home.kind.surface.lower' },
} as const satisfies Record<DecorFit, { title: CopyKey; lower: CopyKey }>

/** A slot kind as a group heading: "Wall". */
export function decorKindHeading(kind: DecorFit, { copy = activeCopy }: HomeCopyOptions = {}) {
  return copy(KIND_KEYS[kind].title)
}

/** A slot kind inside a sentence: "wall". */
export function decorKindWord(kind: DecorFit, { copy = activeCopy }: HomeCopyOptions = {}) {
  return copy(KIND_KEYS[kind].lower)
}

/** A slot's name in `home` ("Windowsill"), from data/homes/interiors.json. */
export function slotName(
  home: HomeId,
  slotId: string,
  { copy = activeCopy }: HomeCopyOptions = {},
) {
  const slot = interiorsJson.homes[home].slots.find((entry) => entry.id === slotId)
  if (slot === undefined) throw new Error(`homes/interiors.json: ${home} has no slot "${slotId}"`)
  return copy(requireKey(slot.nameKey, `slot ${home}/${slotId}`))
}

/** A decor colour variant's human name ("Hot pink"), never its hex or token (A11Y-1). */
export function variantName(itemId: string, variantId: string, options: HomeCopyOptions = {}) {
  const { copy = activeCopy, config = engineConfig } = options
  const variant = decor(itemId, config).decor.variants.find((entry) => entry.id === variantId)
  if (variant === undefined) throw new Error(`decor "${itemId}" has no variant "${variantId}"`)
  return copy(requireKey(variant.nameKey, `variant ${itemId}/${variantId}`))
}

/** "Home score 14: +14 clout", saying so when the home clout cap holds it. */
export function homeScoreLine(
  player: Pick<PlayerState, 'home' | 'inventory' | 'apartment'>,
  options: HomeCopyOptions = {},
): string {
  const { copy = activeCopy, config = engineConfig } = options
  const score = homeScore(player, config)
  const clout = homeClout(player, config)
  const vars = { score: formatCount(score), clout: formatCount(clout) }
  return copy(score > config.home.maxClout ? 'home.scoreCapped' : 'home.score', vars)
}

/** "Queens room, rent $280/wk". */
export function currentHomeLine(home: HomeId, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  return copy('home.current', {
    home: homeName(home, options),
    rent: formatMoney(rentFor(home, config)),
  })
}

/** "Hot pink fairy lights": what sits in a slot, with its colour. */
export function slotHoldsLine(itemId: string, variantId: string, options: HomeCopyOptions = {}) {
  const { copy = activeCopy } = options
  return copy('home.slot.holds', {
    item: itemName(itemId, options),
    color: variantName(itemId, variantId, options),
  })
}

export function placeLabel(
  itemId: string,
  home: HomeId,
  slotId: string,
  options: HomeCopyOptions = {},
) {
  const { copy = activeCopy } = options
  return copy('home.slot.placeLabel', {
    item: itemName(itemId, options),
    slot: slotName(home, slotId, options),
  })
}

export function removeLabel(
  itemId: string,
  home: HomeId,
  slotId: string,
  options: HomeCopyOptions = {},
) {
  const { copy = activeCopy } = options
  return copy('home.slot.removeLabel', {
    item: itemName(itemId, options),
    slot: slotName(home, slotId, options),
  })
}

export function pickUpLabel(itemId: string, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('home.storage.pickUpLabel', { item: itemName(itemId, options) })
}

export function putDownLabel(itemId: string, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('home.storage.putDownLabel', { item: itemName(itemId, options) })
}

/** "Fits a wall spot". */
export function fitsLine(itemId: string, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  return copy('home.storage.fits', {
    kind: decorKindWord(decor(itemId, config).decor.fits, options),
  })
}

/** The instruction while an item is held: "Holding Fairy lights. Choose a wall spot, ...". */
export function pickedNotice(itemId: string, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  return copy('home.picked', {
    item: itemName(itemId, options),
    kind: decorKindWord(decor(itemId, config).decor.fits, options),
  })
}

export function placedNotice(
  itemId: string,
  home: HomeId,
  slotId: string,
  options: HomeCopyOptions = {},
) {
  const { copy = activeCopy } = options
  return copy('home.placed', {
    item: itemName(itemId, options),
    slot: slotName(home, slotId, options),
  })
}

export function removedNotice(itemId: string, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('home.removed', { item: itemName(itemId, options) })
}

export function variantLegend(itemId: string, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('home.variant.legend', { item: itemName(itemId, options) })
}

export function variantChangedNotice(
  itemId: string,
  variantId: string,
  options: HomeCopyOptions = {},
) {
  const { copy = activeCopy } = options
  return copy('home.variant.changed', {
    item: itemName(itemId, options),
    color: variantName(itemId, variantId, options),
  })
}

export function slotSelectedNotice(home: HomeId, slotId: string, options: HomeCopyOptions = {}) {
  const { copy = activeCopy } = options
  return copy('home.selected', { slot: slotName(home, slotId, options) })
}

function moveVars(home: HomeId, options: HomeCopyOptions) {
  const { config = engineConfig } = options
  return {
    home: homeName(home, options),
    cost: formatMoney(moveInCost(home, config)),
    rent: formatMoney(rentFor(home, config)),
    slots: formatCount(slotsFor(home, config).length),
  }
}

/** "Move-in $400, rent $520/wk, 5 slots": the numbers under a home in the Move list. */
export function moveDetails(home: HomeId, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('home.move.details', moveVars(home, options))
}

export function moveButtonText(home: HomeId, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('home.move.button', { home: homeName(home, options) })
}

/** The accessible name of an open home's Move button, with its cost, rent and slot count. */
export function moveLabel(home: HomeId, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('home.move.label', moveVars(home, options))
}

/** The confirmation step's question, with what the move costs and changes. */
export function moveConfirmText(home: HomeId, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('home.move.confirm', moveVars(home, options))
}

export function movedNotice(home: HomeId, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('home.move.done', moveVars(home, options))
}

function boroughName(borough: Borough, { copy = activeCopy }: HomeCopyOptions) {
  return copy(requireKey(`boroughs.${camelSegment(borough)}.name`, `borough ${borough}`))
}

/** Why a home is locked, in voice where the slang pack has it. */
export function homeLockReason(lock: HomeLock, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  switch (lock.code) {
    case 'CURRENT_HOME':
      return copy('home.lock.current')
    case 'FUNDS_SHORT':
      return copy('home.lock.funds', {
        required: formatMoney(lock.required),
        available: formatMoney(lock.available),
      })
    case 'BOROUGH_LOCKED': {
      if (lock.access.status === 'expanding-soon') {
        return copy('home.lock.soon', { borough: boroughName(lock.borough, options) })
      }
      const vars = {
        borough: boroughName(lock.borough, options),
        level: cloutLevelName(lock.access.required, options),
        current: cloutLevelName(lock.access.current, options),
      }
      // A home with its own line ("Manhattan loft? On bodega money? ...") uses it.
      const ownKey = `home.lock.${camelSegment(lock.home)}`
      return copy(isCopyKey(ownKey) ? ownKey : 'home.lock.borough', vars)
    }
  }
}

/**
 * A locked home's accessible name: "{home}. {reason}" (A11Y-2), so a screen reader hears why
 * before it hears that the button is unavailable.
 */
export function homeLockName(lock: HomeLock, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('home.lock.name', {
    home: homeName(lock.home, options),
    reason: homeLockReason(lock, options),
  })
}

/**
 * The player-facing text for an engine home error. The panel offers only what the engine
 * allows, so these show only when the state moved under it (a sale in another tab, a reload).
 */
export function homeErrorText(error: HomeError, options: HomeCopyOptions = {}): string {
  const { copy = activeCopy, config = engineConfig } = options
  switch (error.code) {
    case 'UNKNOWN_ITEM':
      return copy('home.error.unknownItem')
    case 'NOT_DECOR':
      return copy('home.error.notDecor')
    case 'NOT_OWNED':
      return copy('home.error.notOwned')
    case 'UNKNOWN_SLOT':
      return copy('home.error.unknownSlot')
    case 'WRONG_SLOT_KIND':
      return copy('home.error.wrongKind', {
        item: findItem(error.itemId, config) === undefined ? '' : itemName(error.itemId, options),
        fits: decorKindWord(error.fits, options),
        kind: decorKindWord(error.kind, options),
      })
    case 'UNKNOWN_VARIANT':
      return copy('home.error.unknownVariant')
    case 'UNKNOWN_HOME':
      return copy('home.error.unknownHome')
    case 'CURRENT_HOME':
    case 'BOROUGH_LOCKED':
    case 'FUNDS_SHORT':
      return homeLockReason(error, options)
  }
}
