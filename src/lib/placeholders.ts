/**
 * Copy placeholder syntax, shared by the copy layer and the copy schema. Zod-free, because the
 * copy layer ships to the browser.
 *
 * A placeholder is `{name}`: a letter, then letters or digits. Any other brace (`{1x}`, `{ a }`,
 * a lone `{` or `}`) is malformed and rejected, so it can never render literally to a player.
 */
export const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g

/** Placeholder names in a template, in order of first use. */
export function placeholdersOf(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(PLACEHOLDER), (m) => m[1] ?? ''))]
}

/** True when a brace in `template` is not part of a valid `{name}` placeholder. */
export function hasMalformedPlaceholder(template: string): boolean {
  return /[{}]/.test(template.replace(PLACEHOLDER, ''))
}
