import { z } from 'zod'

/**
 * Validates one /data file against its schema at import time, so bad content fails the build
 * and the tests instead of reaching players (fail fast). The error names the file.
 */
export function parseDataFile<T extends z.ZodType>(
  file: string,
  schema: T,
  json: unknown,
): z.output<T> {
  const result = schema.safeParse(json)
  if (!result.success) {
    throw new Error(`Invalid data file ${file}:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
