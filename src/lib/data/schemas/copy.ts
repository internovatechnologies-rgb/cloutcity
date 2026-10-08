/**
 * Schemas for /data/copy: per-namespace base strings (data/copy/<ns>/base.json), per-namespace
 * slang-pack overrides (data/copy/<ns>/<pack>.json) and the superlative words
 * (data/copy/superlatives.json). See src/lib/copy/registry.ts.
 */
import { z } from 'zod'
import { hasMalformedPlaceholder } from '../../placeholders'
import { CopyKeyRefSchema } from './content'

/** Superlative words players may see, but only through `superlative()` (computed from data). */
export const SUPERLATIVE_KINDS = ['cheapest', 'biggest', 'best', 'most', 'fastest'] as const
export type SuperlativeKind = (typeof SUPERLATIVE_KINDS)[number]

/** One copy string. Braces must form valid `{name}` placeholders. */
const CopyStringSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((text) => !hasMalformedPlaceholder(text), {
    error: 'malformed placeholder: use {name} (a letter, then letters or digits)',
  })

/** data/copy/superlatives.json: the only place superlative words may appear (GR-11). */
export const SuperlativesSchema = z.strictObject({
  cheapest: CopyStringSchema,
  biggest: CopyStringSchema,
  best: CopyStringSchema,
  most: CopyStringSchema,
  fastest: CopyStringSchema,
})

/** data/copy/<ns>/base.json: one namespace's strings in plain English (keys start `<ns>.`). */
export const NamespaceBaseSchema = z.strictObject({
  strings: z.record(CopyKeyRefSchema, CopyStringSchema),
})

/** Every namespace merged (src/lib/copy/all.ts), with the superlative words. */
export const BaseCopySchema = z.strictObject({
  /** Every player-facing string, in plain English. Packs may override any of them. */
  strings: z.record(CopyKeyRefSchema, CopyStringSchema),
  superlatives: SuperlativesSchema,
})
export type BaseCopy = z.infer<typeof BaseCopySchema>

/**
 * A slang pack's overrides: data/copy/<ns>/<pack>.json, or every namespace merged. Unknown keys
 * are rejected in src/lib/copy/files.test.ts.
 */
export const SlangPackSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  strings: z.record(CopyKeyRefSchema, CopyStringSchema),
})
export type SlangPack = z.infer<typeof SlangPackSchema>
