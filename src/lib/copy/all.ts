/**
 * Every copy namespace at once, for tests, tools and server code that needs the whole catalogue.
 * Never import this from browser code: it would put every string in one chunk (the shell guard,
 * src/lib/shell-boundary.test.ts, denies it on the shell path).
 *
 * Exports the merged base and packs in the shapes the copy layer has always used, so
 * `createCopy(baseCopy, slangPacks.nyc)` renders any key regardless of what the registry holds.
 */
import type { BaseCopy, SlangPack } from '@/lib/data/schemas/copy'
import { copyConfig, superlativeWords } from './index'
import './ns/actions'
import './ns/ageGate'
import './ns/app'
import './ns/audio'
import './ns/boroughs'
import './ns/clout'
import './ns/colors'
import './ns/club'
import './ns/credits'
import './ns/events'
import './ns/goals'
import './ns/home'
import './ns/housing'
import './ns/hud'
import './ns/inventory'
import './ns/items'
import './ns/jobs'
import './ns/landmarks'
import './ns/legal'
import './ns/loading'
import './ns/map'
import './ns/mod'
import './ns/models'
import './ns/nav'
import './ns/offline'
import './ns/place'
import './ns/places'
import './ns/premium'
import './ns/profile'
import './ns/rent'
import './ns/safety'
import './ns/settings'
import './ns/share'
import './ns/shop'
import './ns/sync'
import './ns/tabs'
import './ns/tour'
import './ns/travel'
import './ns/venues'
import './ns/voice'
import './ns/welcome'
import { registeredNamespace, registeredNamespaces } from './registry'

function merged(pick: (namespace: string) => Readonly<Record<string, string>> | undefined) {
  const strings: Record<string, string> = {}
  for (const namespace of registeredNamespaces().sort()) Object.assign(strings, pick(namespace))
  return strings
}

/** Every base string of every namespace, and the superlative words. */
export const baseCopy: BaseCopy = {
  strings: merged((namespace) => registeredNamespace(namespace)?.base.strings),
  superlatives: superlativeWords,
}

/** Every slang pack named in data/config/copy.json, merged across namespaces, by id. */
export const slangPacks: Readonly<Record<string, SlangPack>> = Object.fromEntries(
  copyConfig.packs.map((id) => [
    id,
    { id, strings: merged((namespace) => registeredNamespace(namespace)?.packs[id]?.strings) },
  ]),
)
