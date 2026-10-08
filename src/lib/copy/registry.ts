/**
 * The copy namespace registry (DEC-11). A namespace is the first segment of a key
 * (`events.mtaDelay.title` → `events`), stored as data/copy/<ns>/base.json plus one optional
 * file per slang pack. Each namespace has a module in ./ns that registers its files; the copy
 * core registers the small boot namespaces, and a feature module imports the namespaces it uses,
 * so their strings ship in the feature's chunk instead of the shell.
 *
 * This module holds no JSON of its own: the namespace modules import it, and the copy core
 * imports them, so it must not import either (no import cycle).
 */

/** The strings of one namespace in plain English. */
export interface NamespaceStrings {
  readonly strings: Readonly<Record<string, string>>
}

export interface RegisteredNamespace {
  readonly base: NamespaceStrings
  /** Pack overrides for this namespace, by pack id. A pack with no overrides has no entry. */
  readonly packs: Readonly<Record<string, NamespaceStrings>>
}

/**
 * Thrown when a key's namespace has not been registered: the module rendering it forgot to
 * import `@/lib/copy/ns/<namespace>`. A bug, never shown as the raw key.
 */
export class CopyNamespaceNotLoadedError extends Error {
  readonly namespace: string
  readonly key: string

  constructor(namespace: string, key: string) {
    super(
      `Copy namespace "${namespace}" is not loaded for key "${key}": import '@/lib/copy/ns/${namespace}' in the module that renders it`,
    )
    this.name = 'CopyNamespaceNotLoadedError'
    this.namespace = namespace
    this.key = key
  }
}

const registry = new Map<string, RegisteredNamespace>()

/** The namespace of a key: its first dot-separated segment. */
export function namespaceOf(key: string): string {
  const dot = key.indexOf('.')
  return dot === -1 ? key : key.slice(0, dot)
}

/**
 * Registers (or, on hot reload, replaces) a namespace. Every base key must start with `<ns>.`;
 * src/lib/copy/files.test.ts checks the files on disk.
 */
export function registerCopy(
  namespace: string,
  base: NamespaceStrings,
  packs: Readonly<Record<string, NamespaceStrings>>,
): void {
  registry.set(namespace, { base, packs })
}

/** The registered files of a namespace, or undefined when it is not loaded. */
export function registeredNamespace(namespace: string): RegisteredNamespace | undefined {
  return registry.get(namespace)
}

/** Every namespace registered so far. */
export function registeredNamespaces(): string[] {
  return [...registry.keys()]
}

/**
 * Keys no slang pack may change (S18b): crisis resources read the same, plainly, in every voice.
 * A pack that overrides one is ignored for that key (src/lib/copy/slangImmune.test.ts).
 */
export const SLANG_IMMUNE_KEY = /^(?:safety\.crisis\.|legal\.conduct\.crisis\.)/

/**
 * The template for `key` in `packId` (falling back to base), or undefined when its namespace is
 * loaded but has no such key. A slang-immune key always comes from base. Throws {@link CopyNamespaceNotLoadedError} when the namespace is
 * not loaded.
 */
export function lookupTemplate(key: string, packId: string): string | undefined {
  const namespace = namespaceOf(key)
  const entry = registry.get(namespace)
  if (entry === undefined) throw new CopyNamespaceNotLoadedError(namespace, key)
  const pack = entry.packs[packId]
  if (pack !== undefined && Object.hasOwn(pack.strings, key) && !SLANG_IMMUNE_KEY.test(key)) {
    return pack.strings[key]
  }
  return Object.hasOwn(entry.base.strings, key) ? entry.base.strings[key] : undefined
}

/** True when `key`'s namespace is loaded and its base has that key. */
export function hasRegisteredKey(key: string): boolean {
  const entry = registry.get(namespaceOf(key))
  return entry !== undefined && Object.hasOwn(entry.base.strings, key)
}
