/**
 * The handle filter (S18a), the TypeScript twin of `private.handle_allowed` in
 * supabase/migrations/*_s18a_handles_profile.sql. The server's copy is the one that decides;
 * this one lets unit tests prove every generated word pair passes and that the two agree.
 *
 * The terms come in as an argument: data/moderation/handle-blocklist.json is never imported by
 * browser code (src/lib/client-imports.test.ts), so the list is not shipped to players.
 */
import { handleSkeleton, squeezeRepeats } from './normalise.ts'

/** Flattened data/moderation/handle-blocklist.json, every term already in skeleton form. */
export interface HandleTerms {
  /** Refused anywhere in the handle (after allowlisted words are taken out). */
  readonly contains: readonly string[]
  /** Refused as the whole handle, with or without trailing digits. */
  readonly exact: readonly string[]
  /** Innocent words that contain a `contains` term (badminton, cocktail, therapist). */
  readonly allow: readonly string[]
}

/** The blocklist file's shape (HandleBlocklistSchema), as plain types for this pure module. */
export interface HandleBlocklistGroups {
  readonly contains: Readonly<Record<string, readonly string[]>>
  readonly exact: Readonly<Record<string, readonly string[]>>
  readonly allow: readonly string[]
}

const sortedUnique = (terms: Iterable<string>) => [...new Set(terms)].sort()

/** The source groups merged: what the database seed holds, one row per mode and term. */
export function flattenBlocklist(blocklist: HandleBlocklistGroups): HandleTerms {
  return {
    contains: sortedUnique(Object.values(blocklist.contains).flat()),
    exact: sortedUnique(Object.values(blocklist.exact).flat()),
    allow: sortedUnique(blocklist.allow),
  }
}

/** Longest first, then by code point: the order `private.handle_allowed` strips them in. */
export function allowOrder(terms: readonly string[]): string[] {
  return [...terms].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
}

/** A space can never be part of a term, so a term cannot straddle a removed allowlisted word. */
function stripAllowed(text: string, allow: readonly string[]): string {
  let result = text
  for (const word of allow) result = result.replaceAll(word, ' ')
  return result
}

/**
 * Whether a handle (already in valid format) passes the filter. Every form is compared in
 * skeleton form (leetspeak read as letters, underscores dropped). Repeated letters are also
 * squeezed (`fuuun` → `fun`), but only against terms that have no repeats of their own, so a
 * term like `boob` never refuses `Bob`.
 */
export function handleAllowed(handle: string, terms: HandleTerms): boolean {
  const skeleton = handleSkeleton(handle)
  const bare = handleSkeleton(handle.replace(/[0-9_]+$/, ''))
  const squeezed = [squeezeRepeats(skeleton), squeezeRepeats(bare)]
  const repeatFree = (term: string) => squeezeRepeats(term) === term

  for (const term of terms.exact) {
    if (term === skeleton || term === bare) return false
    if (repeatFree(term) && squeezed.includes(term)) return false
  }

  const allow = allowOrder(terms.allow)
  const raw = stripAllowed(skeleton, allow)
  const squeezedRaw = stripAllowed(squeezeRepeats(skeleton), allow.map(squeezeRepeats))
  for (const term of terms.contains) {
    if (raw.includes(term)) return false
    if (repeatFree(term) && squeezedRaw.includes(term)) return false
  }
  return true
}
