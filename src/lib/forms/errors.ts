/**
 * The shared form pattern (GR-1, GR-2): one zod schema per form, whose issue messages are copy
 * keys. Every field is validated together, so all errors show at once, and the errors are
 * recomputed from the current values on every change and every submit.
 */
import type { z } from 'zod/mini'
import { isCopyKey, type CopyKey } from '@/lib/copy'

export type FieldErrors<Field extends string> = Partial<Record<Field, CopyKey>>

/**
 * The first error of each field (by `path[0]`) for `values`, as a copy key. An issue message
 * that is not a copy key is a bug in the schema, so it throws instead of showing raw text.
 */
export function fieldErrors<Field extends string>(
  schema: z.ZodMiniType,
  values: Readonly<Record<Field, unknown>>,
): FieldErrors<Field> {
  const result = schema.safeParse(values)
  if (result.success) return {}
  const errors: FieldErrors<Field> = {}
  for (const issue of result.error.issues) {
    const field = issue.path[0]
    if (typeof field !== 'string' || !(field in values)) continue
    if (!isCopyKey(issue.message)) {
      throw new Error(`Form error for "${field}" is not a copy key: "${issue.message}"`)
    }
    const key = field as Field
    errors[key] ??= issue.message
  }
  return errors
}

/** The first field in `order` (DOM order) that has an error, for moving focus to it. */
export function firstInvalid<Field extends string>(
  order: readonly Field[],
  errors: FieldErrors<Field>,
): Field | undefined {
  return order.find((field) => errors[field] !== undefined)
}
