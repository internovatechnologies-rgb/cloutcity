/**
 * The free-text filter for report notes (S18b) and, later, chat (S20a): the TypeScript twin of
 * `private.normalize_text` and `private.contains_contact_info` in
 * supabase/migrations/*_s18b_safety.sql. The server's copy decides; this one lets a form show the
 * error before anything is sent. src/lib/safety/parity.test.ts checks the SQL uses these exact
 * pattern sources, and tests/integration/safety.test.ts runs both on the shared fixtures
 * (textFilter.fixtures.ts).
 *
 * The patterns use only what PostgreSQL's ARE and JavaScript read the same way: literal
 * characters, bracket classes, groups, alternation and bounded quantifiers. No `\b`, `\d` or `\s`
 * (they differ between the two), and every pattern runs on normalised, ASCII-lower-cased text.
 *
 * It looks only for contact details and hidden characters. Slurs and insults are allowed in a
 * report note: they are the evidence.
 */

/**
 * Control characters (tab, newline and carriage return allowed), soft hyphen, zero-width and
 * joiner characters, bidirectional controls, invisible fillers and the byte-order mark. Checked
 * on the raw text: they can hide a link from the patterns below.
 */
export const HIDDEN_CHARS_PATTERN =
  '[\\u0001-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u3164\\uFEFF\\uFFA0\\uFFF9-\\uFFFB]'

/** Whitespace runs that become one space (NFKC has already turned the wide spaces into ' '). */
export const WHITESPACE_PATTERN = '[\\t\\n\\u000B\\f\\r\\u0085\\u2028\\u2029 ]+'

const DOT = '(\\.| ?\\(dot\\) ?| ?\\[dot\\] ?| dot )'
const TLDS = '(com|net|org|io|gg|ly|co|app|xyz|tv|me|info|link|live|dev|uk|ca)'

/** Each pattern runs on normalizeText's output. Keep the order: the SQL lists them the same. */
export const CONTACT_PATTERNS = [
  // A URL scheme: https://, ftp://, app links.
  '[a-z][a-z0-9+.-]*://',
  // www. in any spelling of the dot.
  `(^|[^a-z0-9])www${DOT}`,
  // A bare domain with a common top-level domain: cloutcity.com, discord dot gg.
  `[a-z0-9-]+${DOT}${TLDS}([^a-z0-9]|$)`,
  // An email address, with @ or a spelled-out (at).
  `[a-z0-9._%+-]+ ?(@|\\(at\\)|\\[at\\]) ?[a-z0-9-]+${DOT}[a-z]{2,}`,
  // A social @handle.
  '(^|[^a-z0-9_.])@[a-z0-9_.]{2,}',
  // A platform name pointing at a handle: ig: name, snap = name.
  '(^|[^a-z0-9])(instagram|insta|ig|snapchat|snap|tiktok|twitter|telegram|whatsapp|discord|kik|venmo|cashapp) ?(:|=) ?[a-z0-9_.]{2,}',
  // A phone number: seven or more digits, with up to two separators between digits.
  '[0-9]([ ().+-]{0,2}[0-9]){6,}',
] as const

const HIDDEN_CHARS = new RegExp(HIDDEN_CHARS_PATTERN, 'u')
const WHITESPACE = new RegExp(WHITESPACE_PATTERN, 'gu')
const CONTACT = CONTACT_PATTERNS.map((source) => new RegExp(source, 'u'))

/**
 * What the patterns compare: NFKC (full-width and stylised letters become plain ones), ASCII
 * letters lower-cased (only ASCII, so both sides agree whatever the database's locale), every
 * whitespace run one space, no space at either end.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(WHITESPACE, ' ')
    .replace(/^ +| +$/g, '')
}

/** Whether the text holds a link, an email, a phone number, a social handle or a hidden character. */
export function containsContactInfo(text: string): boolean {
  if (HIDDEN_CHARS.test(text)) return true
  const normalized = normalizeText(text)
  return CONTACT.some((pattern) => pattern.test(normalized))
}
