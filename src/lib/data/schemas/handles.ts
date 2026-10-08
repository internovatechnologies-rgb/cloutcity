/**
 * Schemas for the handle data (S18a): the words guest handles are made from
 * (data/copy/handleWords.json) and the handle blocklist (data/moderation/handle-blocklist.json).
 * Both are copied into the database by the migration's generated seed
 * (scripts/moderation/blocklist-sql.ts); neither is ever imported by browser code.
 */
import { z } from 'zod'
import { handleSkeleton } from '../../handles/normalise.ts'

const unique = (list: readonly string[]) => new Set(list).size === list.length

/** One capitalised word, so AdjectiveNoun reads as a name: `Bodega`, `Swift`. */
const HandleWordSchema = z.string().regex(/^[A-Z][a-z]{2,6}$/)

const WordListSchema = z
  .array(HandleWordSchema)
  .min(50)
  .refine(unique, { error: 'words must be unique' })

/**
 * data/copy/handleWords.json. Two seven-letter words and two digits fill the 16-character
 * maximum, so any pair fits; src/lib/handles/filter.test.ts proves every pair passes the filter.
 */
export const HandleWordsSchema = z.strictObject({
  adjectives: WordListSchema,
  nouns: WordListSchema,
})
export type HandleWords = z.infer<typeof HandleWordsSchema>

/** A blocklist term as the filter compares it: lower case, leetspeak already read as letters. */
const TermSchema = z
  .string()
  .regex(/^[a-z0-9]{2,40}$/)
  .refine((term) => handleSkeleton(term) === term, { error: 'term must be in skeleton form' })

/** Terms grouped by where they came from (see data/moderation/SOURCES.md). */
const TermGroupsSchema = z.record(
  z.string().regex(/^[a-z][A-Za-z]*$/),
  z.array(TermSchema).min(1).refine(unique, { error: 'terms must be unique within a group' }),
)

/** data/moderation/handle-blocklist.json. */
export const HandleBlocklistSchema = z.strictObject({
  contains: TermGroupsSchema,
  exact: TermGroupsSchema,
  allow: z.array(TermSchema).refine(unique, { error: 'allowlisted words must be unique' }),
})
export type HandleBlocklist = z.infer<typeof HandleBlocklistSchema>
