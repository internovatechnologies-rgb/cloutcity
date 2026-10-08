/**
 * The copy layer. Every player-facing string comes from data/copy/<namespace>/base.json, with
 * the active slang pack (data/config/copy.json `slangPack`, a file data/copy/<namespace>/<pack>.json
 * where the pack overrides that namespace) layered over it. Swapping `slangPack` in config
 * changes the text with no code change.
 *
 * Strings are split by namespace (the first key segment) so the shell carries only the boot
 * namespaces this module registers (app, nav, tabs, loading). Any other namespace loads with the
 * feature that uses it: the feature module imports `@/lib/copy/ns/<namespace>`, so its strings
 * ship in that feature's chunk (DEC-11). Rendering a key whose namespace is not loaded throws
 * {@link CopyNamespaceNotLoadedError}: it is a bug, never shown as the raw key.
 *
 * Templates use `{name}` placeholders. Values are strings only, so numbers must go through the
 * shared formatters in src/lib/format.ts first (UX-2).
 *
 * This module ships to the browser, so it does not import zod. The copy files are bundled at
 * build time, not user input: their schemas run in src/lib/copy/files.test.ts, which gates
 * every build.
 *
 * Superlatives (GR-11): copy strings never contain "cheapest", "biggest", "best", "most" or
 * "fastest" as literal text (copy.test.ts enforces it). A string that needs one takes a
 * placeholder, and the caller fills it with `superlative(...)`, which returns the word only
 * when the data proves it:
 *
 *   copy('housing.rentRank', { rank: superlative('cheapest', home.id, rents) ?? '' })
 */
import copyConfigJson from '@data/config/copy.json'
import superlativesJson from '@data/copy/superlatives.json'
import type { CopyConfig } from '@/lib/data/schemas/config'
import type { BaseCopy, SlangPack, SuperlativeKind } from '@/lib/data/schemas/copy'
import { PLACEHOLDER, hasMalformedPlaceholder, placeholdersOf } from '@/lib/placeholders'
import type { CopyKey } from './keys'
import { hasRegisteredKey, lookupTemplate } from './registry'
// The boot namespaces: the shell's own copy.
import './ns/app'
import './ns/loading'
import './ns/nav'
import './ns/tabs'

/** The namespaces the copy core registers itself: the shell's own copy (imported above). */
export const BOOT_NAMESPACES = ['app', 'loading', 'nav', 'tabs'] as const

export type { CopyKey }
export { CopyNamespaceNotLoadedError } from './registry'
export type CopyVars = Readonly<Record<string, string>>
export type CopyFn = (key: CopyKey, vars?: CopyVars) => string

export const copyConfig: CopyConfig = copyConfigJson
export const superlativeWords: BaseCopy['superlatives'] = superlativesJson

export { placeholdersOf }

/**
 * Fills `{name}` placeholders. A missing value or a malformed placeholder throws: a
 * half-rendered string is a bug.
 */
export function interpolate(template: string, vars: CopyVars = {}): string {
  if (hasMalformedPlaceholder(template)) {
    throw new Error(`Copy template has a malformed placeholder: "${template}"`)
  }
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`Copy placeholder {${name}} has no value`)
    return value
  })
}

/**
 * A copy function for one complete base and one pack, independent of the registry (tests and
 * tools build these from src/lib/copy/all.ts). Pack strings win over base strings.
 */
export function createCopy(base: Pick<BaseCopy, 'strings'>, pack: SlangPack): CopyFn {
  return (key, vars) => {
    const template = pack.strings[key] ?? base.strings[key]
    if (template === undefined) throw new Error(`Unknown copy key "${key}"`)
    return interpolate(template, vars)
  }
}

/** True when `value` names a base string of a loaded namespace. */
export function isCopyKey(value: string): value is CopyKey {
  return hasRegisteredKey(value)
}

/** One piece of a template split by {@link copyParts}: literal text, or a named slot. */
export type CopyPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'slot'; readonly name: string }

/**
 * Splits a template into text and `{name}` slots, so a component can put an element (a link)
 * where a placeholder sits without the copy losing its word order. Throws on a malformed
 * placeholder, like `interpolate`.
 */
export function splitTemplate(template: string): CopyPart[] {
  if (hasMalformedPlaceholder(template)) {
    throw new Error(`Copy template has a malformed placeholder: "${template}"`)
  }
  const parts: CopyPart[] = []
  let last = 0
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (match.index > last) parts.push({ kind: 'text', text: template.slice(last, match.index) })
    parts.push({ kind: 'slot', name: match[1] ?? '' })
    last = match.index + match[0].length
  }
  if (last < template.length) parts.push({ kind: 'text', text: template.slice(last) })
  return parts
}

/** The active-pack template for `key`; throws if its namespace is not loaded or it is unknown. */
function activeTemplate(key: CopyKey): string {
  const template = lookupTemplate(key, copyConfig.slangPack)
  if (template === undefined) throw new Error(`Unknown copy key "${key}"`)
  return template
}

/** Renders a copy string with the active slang pack. */
export const copy: CopyFn = (key, vars) => interpolate(activeTemplate(key), vars)

/** The active-pack template for `key`, split into text and slots (see {@link splitTemplate}). */
export function copyParts(key: CopyKey): CopyPart[] {
  return splitTemplate(activeTemplate(key))
}

const SUPERLATIVE_DIRECTION: Readonly<Record<SuperlativeKind, 'min' | 'max'>> = {
  cheapest: 'min',
  fastest: 'min',
  biggest: 'max',
  best: 'max',
  most: 'max',
}

export interface RankedValue {
  readonly id: string
  readonly value: number
}

/**
 * The superlative word for `subjectId` if, and only if, the data proves it: the subject holds
 * the unique minimum (cheapest, fastest) or maximum (biggest, best, most) of `values`. Returns
 * null on a tie, a NaN, fewer than two distinct ids, an unknown subject or a subject listed
 * more than once (its rank would be ambiguous), so copy never claims a rank the
 * numbers do not support (GR-11).
 */
export function superlative(
  kind: SuperlativeKind,
  subjectId: string,
  values: readonly RankedValue[],
  words: Pick<BaseCopy, 'superlatives'> = { superlatives: superlativeWords },
): string | null {
  const subjects = values.filter((entry) => entry.id === subjectId)
  const subject = subjects[0]
  if (subject === undefined || subjects.length > 1) return null
  if (new Set(values.map((entry) => entry.id)).size < 2) return null
  const isMin = SUPERLATIVE_DIRECTION[kind] === 'min'
  const beaten = values.every(
    (entry) =>
      entry.id === subjectId || (isMin ? subject.value < entry.value : subject.value > entry.value),
  )
  return beaten ? words.superlatives[kind] : null
}

const LITERAL_SUPERLATIVE = /\b(cheapest|biggest|best|most|fastest)\b/gi

export interface LiteralSuperlative {
  readonly key: string
  readonly word: string
}

/**
 * Finds superlatives written as literal text. Placeholders are removed first: a placeholder's
 * name is not player-facing, and its value is computed at render time.
 */
export function findLiteralSuperlatives(
  strings: Readonly<Record<string, string>>,
): LiteralSuperlative[] {
  const found: LiteralSuperlative[] = []
  for (const [key, text] of Object.entries(strings)) {
    for (const match of text.replace(PLACEHOLDER, ' ').matchAll(LITERAL_SUPERLATIVE)) {
      found.push({ key, word: match[0] })
    }
  }
  return found
}
