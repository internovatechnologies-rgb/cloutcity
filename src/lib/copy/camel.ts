/**
 * Copy keys are camelCase (data/copy schemas), while database enums are snake_case
 * (`sexual_content`, `handle_taken`). These turn one into the other, in the type system too,
 * so a key built from an enum value is still checked against the copy files.
 */
export type SnakeToCamel<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<SnakeToCamel<Tail>>}`
  : S

/** `sexual_content` → `sexualContent`. */
export function snakeToCamel<S extends string>(value: S): SnakeToCamel<S> {
  return value.replace(/_([a-z0-9])/g, (_, letter: string) =>
    letter.toUpperCase(),
  ) as SnakeToCamel<S>
}
