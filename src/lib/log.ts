/**
 * Structured logger. The only module allowed to touch `console` (lint bans it everywhere else).
 *
 * Every record is one JSON-serialisable object with a level, a message, a timestamp, a
 * correlation id and optional context fields. Sensitive fields (emails, tokens, chat text,
 * report notes, passwords) are redacted by key before a record leaves the logger, so a careless
 * call site cannot leak them (CLAUDE.md: never log emails, tokens, chat text or report notes).
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export type LogContext = Readonly<Record<string, unknown>>

export interface LogRecord {
  readonly level: LogLevel
  readonly msg: string
  readonly time: string
  readonly correlationId: string
  readonly context?: LogContext
}

export type LogSink = (record: LogRecord) => void

export interface Logger {
  readonly correlationId: string
  debug(msg: string, context?: LogContext): void
  info(msg: string, context?: LogContext): void
  warn(msg: string, context?: LogContext): void
  error(msg: string, context?: LogContext): void
  /** A logger that shares this one's sink and level but carries a different correlation id. */
  withCorrelationId(correlationId: string): Logger
}

export interface LoggerOptions {
  /** Records below this level are dropped. */
  readonly level?: LogLevel
  /** Ties together the records of one request, session or flow. Generated when omitted. */
  readonly correlationId?: string
  /** Where records go. Defaults to the console. */
  readonly sink?: LogSink
  /** Injected clock so records are deterministic in tests. */
  readonly now?: () => Date
}

export const REDACTED = '[redacted]'

// Matched case-insensitively against each context key, at any depth.
const SENSITIVE_KEY = /e-?mail|token|secret|password|passwd|authorization|cookie|chat|message|note/i

const MAX_DEPTH = 5

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level)
}

// Value patterns, applied to every string and to `msg`, so secrets under innocent keys or
// interpolated into text are caught too.
const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi
const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g

// A `name=value` pair in a query string or fragment: after `?`, `#`, `&` or `;` in a URL, or at
// the start of a bare query string (start of text or after whitespace).
const URL_PARAM = /(^|[?#&;\s])([^=?&#;\s]+)=([^&#;\s]*)/g
// Credentials that travel in URLs besides the sensitive key names (OAuth codes, API keys,
// signatures, one-time passwords). Matched against the whole, decoded parameter name.
const SENSITIVE_PARAM = /^(?:code|key|api[_-]?key|sig|signature|otp|session|sid)$/i

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function isSensitiveParam(name: string): boolean {
  const decoded = decodeName(name)
  return SENSITIVE_KEY.test(decoded) || SENSITIVE_PARAM.test(decoded)
}

/**
 * Replaces secrets inside `text`: values of sensitive URL query and fragment parameters, bearer
 * tokens, JWT-shaped strings and email addresses (plain or `%40`-encoded).
 */
export function scrub(text: string): string {
  return text
    .replace(URL_PARAM, (pair: string, lead: string, name: string) =>
      isSensitiveParam(name) ? `${lead}${name}=${REDACTED}` : pair,
    )
    .replace(BEARER, REDACTED)
    .replace(JWT, REDACTED)
    .replace(EMAIL, REDACTED)
}

/** Object key for a Map key: strings are scrubbed, anything else is serialised as JSON. */
function mapKeyName(key: unknown, depth: number, seen: WeakSet<object>): string {
  if (typeof key === 'string') return scrub(key)
  const json = JSON.stringify(redact(key, depth, seen))
  return json === undefined ? String(key) : json
}

/** `name`, or `name#2`, `name#3`, ... if taken, so redacted or serialised keys never collide. */
function uniqueKey(out: Record<string, unknown>, name: string): string {
  if (!Object.hasOwn(out, name)) return name
  let n = 2
  while (Object.hasOwn(out, `${name}#${n}`)) n += 1
  return `${name}#${n}`
}

/**
 * Returns a JSON-safe copy of `value`: sensitive keys and secret-looking substrings become
 * {@link REDACTED}, Dates become ISO strings, Maps become objects and Sets arrays (their
 * contents redacted too), and cycles become '[circular]'.
 */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrub(value)
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }
  if (value instanceof Error) {
    // Error messages can echo user input, so keep only the name.
    return { name: value.name }
  }
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[truncated]'
  seen.add(value)
  try {
    if (Array.isArray(value) || value instanceof Set) {
      return Array.from(value, (item: unknown) => redact(item, depth + 1, seen))
    }
    const isMap = value instanceof Map
    const entries: Iterable<[unknown, unknown]> = isMap ? value.entries() : Object.entries(value)
    const out: Record<string, unknown> = {}
    for (const [rawKey, inner] of entries) {
      const name = isMap ? mapKeyName(rawKey, depth + 1, seen) : scrub(String(rawKey))
      out[uniqueKey(out, name)] = SENSITIVE_KEY.test(name)
        ? REDACTED
        : redact(inner, depth + 1, seen)
    }
    return out
  } finally {
    // Only ancestors count as cycles; the same object may appear twice side by side.
    seen.delete(value)
  }
}

/** A random, non-persistent id. Never stored, so it is not a persistent identifier (COPPA). */
export function newCorrelationId(): string {
  const { crypto } = globalThis
  // randomUUID exists only in secure contexts; a phone hitting the dev server over LAN http is not one.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/* eslint-disable no-console -- the logger is the single sanctioned console writer */
export const consoleSink: LogSink = (record) => {
  switch (record.level) {
    case 'debug':
      console.debug(record)
      break
    case 'info':
      console.info(record)
      break
    case 'warn':
      console.warn(record)
      break
    case 'error':
      console.error(record)
      break
  }
}
/* eslint-enable no-console */

function defaultLevel(): LogLevel {
  const configured = process.env.NEXT_PUBLIC_LOG_LEVEL
  if (isLogLevel(configured)) return configured
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug'
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? defaultLevel()
  const sink = options.sink ?? consoleSink
  const now = options.now ?? (() => new Date())
  const correlationId = options.correlationId ?? newCorrelationId()

  const write = (recordLevel: LogLevel, msg: string, context?: LogContext): void => {
    if (levelRank(recordLevel) < levelRank(level)) return
    const record: LogRecord = {
      level: recordLevel,
      msg: scrub(msg),
      time: now().toISOString(),
      correlationId,
      ...(context === undefined ? {} : { context: redact(context) as LogContext }),
    }
    sink(record)
  }

  return {
    correlationId,
    debug: (msg, context) => write('debug', msg, context),
    info: (msg, context) => write('info', msg, context),
    warn: (msg, context) => write('warn', msg, context),
    error: (msg, context) => write('error', msg, context),
    withCorrelationId: (id) => createLogger({ level, sink, now, correlationId: id }),
  }
}

/** Process-wide default logger. Create a child with `withCorrelationId` per request or flow. */
export const log: Logger = createLogger()
