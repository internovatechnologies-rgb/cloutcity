/**
 * `npm run handles:sql`: prints the S18a handle seed for a migration. The database cannot read
 * /data, so the handle rules (data/config/handles.json), the guest-handle words
 * (data/copy/handleWords.json) and the blocklist (data/moderation/handle-blocklist.json) are
 * copied into private tables by a generated block in the migration.
 *
 * To change any of the three files: edit it, run this script, and paste the output into a new
 * migration that first deletes the old rows of the three private tables. blocklist-sql.test.ts
 * checks the newest migration holding a seed block and fails while it disagrees with the files.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { HandlesConfigSchema, type HandlesConfig } from '../../src/lib/data/schemas/config.ts'
import {
  HandleBlocklistSchema,
  HandleWordsSchema,
  type HandleBlocklist,
  type HandleWords,
} from '../../src/lib/data/schemas/handles.ts'
import { flattenBlocklist } from '../../src/lib/handles/filter.ts'

const ROOT = resolve(import.meta.dirname, '../..')

export const SEED_BEGIN =
  '-- BEGIN GENERATED handle seed (npm run handles:sql; do not edit by hand)'
export const SEED_END = '-- END GENERATED handle seed'

export interface HandleSeedInputs {
  readonly config: HandlesConfig
  readonly words: HandleWords
  readonly blocklist: HandleBlocklist
}

export function readSeedInputs(root: string = ROOT): HandleSeedInputs {
  const read = (file: string): unknown => JSON.parse(readFileSync(join(root, file), 'utf8'))
  return {
    config: HandlesConfigSchema.parse(read('data/config/handles.json')),
    words: HandleWordsSchema.parse(read('data/copy/handleWords.json')),
    blocklist: HandleBlocklistSchema.parse(read('data/moderation/handle-blocklist.json')),
  }
}

/** Every number in the config under its dotted path: `changes.perWindow`. */
function settings(value: unknown, prefix = ''): [string, number][] {
  if (typeof value === 'number') return [[prefix, value]]
  if (typeof value !== 'object' || value === null) {
    throw new Error(`handles.json ${prefix} is not a number`)
  }
  return Object.entries(value).flatMap(([key, child]) =>
    settings(child, prefix === '' ? key : `${prefix}.${key}`),
  )
}

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

function insert(table: string, columns: string, rows: readonly string[]): string {
  return [`insert into ${table} (${columns}) values`, rows.map((row) => `  ${row}`).join(',\n')]
    .join('\n')
    .concat(';')
}

/** The seed block, markers included, exactly as the migration holds it. */
export function handleSeedSql({ config, words, blocklist }: HandleSeedInputs): string {
  const terms = flattenBlocklist(blocklist)
  const termRows = (['allow', 'contains', 'exact'] as const).flatMap((mode) =>
    terms[mode].map((term) => `(${literal(mode)}, ${literal(term)})`),
  )
  return [
    SEED_BEGIN,
    insert(
      'private.handle_settings',
      'key, value',
      settings(config).map(([key, value]) => `(${literal(key)}, ${value})`),
    ),
    insert('private.handle_words', 'kind, word', [
      ...words.adjectives.map((word) => `('adjective', ${literal(word)})`),
      ...words.nouns.map((word) => `('noun', ${literal(word)})`),
    ]),
    insert('private.handle_terms', 'mode, term', termRows),
    SEED_END,
  ].join('\n')
}

if (import.meta.main) {
  process.stdout.write(`${handleSeedSql(readSeedInputs())}\n`)
}
