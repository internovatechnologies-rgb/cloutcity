/**
 * Handle rules shared by the client and the database (S18a). Each function here has a twin in
 * supabase/migrations/*_s18a_handles_profile.sql; src/lib/handles/parity.test.ts and the
 * integration suite hold them together.
 *
 * Pure and dependency-free (Node scripts import it by relative path): the rules come in as an
 * argument, read from data/config/handles.json by the caller.
 */

/** The parts of data/config/handles.json that shape a handle. */
export interface HandleRules {
  readonly minLength: number
  readonly maxLength: number
  readonly minLetters: number
}

/**
 * The whole format rule as one regular expression, so the SQL check (`private.handle_format_ok`)
 * can use the identical source: ASCII letters, digits and underscores; starts with a letter; at
 * least `minLetters` letters; no double or trailing underscore.
 */
export function handlePattern(rules: HandleRules): RegExp {
  const { minLength, maxLength, minLetters } = rules
  return new RegExp(
    `^(?=.{${minLength},${maxLength}}$)(?=(?:[^A-Za-z]*[A-Za-z]){${minLetters}})[A-Za-z](?:_?[A-Za-z0-9])*$`,
  )
}

/**
 * The uniqueness key: case and underscores do not make a handle different, so `Cool_Cat` and
 * `coolcat` are the same handle (public.handles.handle_key).
 */
export function handleKey(handle: string): string {
  return handle.replaceAll('_', '').toLowerCase()
}

const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
}

/**
 * What the filter compares (`private.handle_skeleton`): lower case, underscores removed and
 * leetspeak digits read as letters, so `B4d_W0rd` is checked as `badword`.
 */
export function handleSkeleton(handle: string): string {
  return handle
    .toLowerCase()
    .replaceAll('_', '')
    .replace(/[013457-9]/g, (digit) => LEET[digit] ?? digit)
}

/** Runs of one character collapsed to one (`private.handle_squeeze`): `fuuun` → `fun`. */
export function squeezeRepeats(text: string): string {
  return text.replace(/(.)\1+/g, '$1')
}

/**
 * The handle form's live preview (GR-6): what the player typed, cleaned into something the
 * format rule can accept. The form always shows this value before it is sent; the server
 * never rewrites a handle, it only accepts or refuses it.
 *
 * Accents are dropped (é → e), spaces, dots and dashes become underscores, any other character
 * is removed, and runs of underscores or underscores at either end are trimmed.
 */
export function normaliseHandleInput(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s.-]+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
}
