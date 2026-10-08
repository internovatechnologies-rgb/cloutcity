/**
 * Finds the local Supabase stack once per run and hands its connection details to the suites
 * (read them with `inject()`). Each value can be overridden by an environment variable, so the
 * suites can also run against another stack (CI). Fails fast, with the fix, when the stack is
 * down or its database is missing the newest local migration.
 */
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import postgres from 'postgres'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    apiUrl: string
    anonKey: string
    serviceRoleKey: string
    dbUrl: string
  }
}

const ROOT = resolve(import.meta.dirname, '../../..')

interface StackInfo {
  apiUrl: string
  anonKey: string
  serviceRoleKey: string
  dbUrl: string
}

async function readStatus(): Promise<Record<string, unknown>> {
  const bin = join(ROOT, 'node_modules', '.bin', 'supabase')
  try {
    const { stdout } = await promisify(execFile)(bin, ['status', '-o', 'json'], { cwd: ROOT })
    const parsed: unknown = JSON.parse(stdout)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('unexpected output')
    return parsed as Record<string, unknown>
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Local Supabase is not running (${reason.split('\n')[0]}). ` +
        'Start it with `npx supabase start`, then `npx supabase migration up --local`.',
    )
  }
}

async function stackInfo(): Promise<StackInfo> {
  const env = {
    apiUrl: process.env.SUPABASE_API_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    dbUrl: process.env.SUPABASE_DB_URL,
  }
  const status = Object.values(env).every(Boolean) ? {} : await readStatus()
  const pick = (override: string | undefined, key: string): string => {
    const value = override ?? status[key]
    if (typeof value !== 'string' || value === '') {
      throw new Error(`\`supabase status\` did not report ${key}; is the stack fully started?`)
    }
    return value
  }
  return {
    apiUrl: pick(env.apiUrl, 'API_URL'),
    anonKey: pick(env.anonKey, 'ANON_KEY'),
    serviceRoleKey: pick(env.serviceRoleKey, 'SERVICE_ROLE_KEY'),
    dbUrl: pick(env.dbUrl, 'DB_URL'),
  }
}

async function assertMigrationsApplied(dbUrl: string): Promise<void> {
  const files = readdirSync(join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql'))
  const newest = files
    .map((file) => file.split('_')[0] ?? '')
    .sort()
    .at(-1)
  if (newest === undefined) return
  const sql = postgres(dbUrl, { max: 1, onnotice: () => undefined })
  try {
    const rows = await sql<{ version: string }[]>`
      select version from supabase_migrations.schema_migrations where version = ${newest}
    `
    if (rows.length === 0) {
      throw new Error(
        `The local database is missing migration ${newest}. Run \`npx supabase migration up --local\`.`,
      )
    }
  } finally {
    await sql.end()
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const info = await stackInfo()
  await assertMigrationsApplied(info.dbUrl)
  project.provide('apiUrl', info.apiUrl)
  project.provide('anonKey', info.anonKey)
  project.provide('serviceRoleKey', info.serviceRoleKey)
  project.provide('dbUrl', info.dbUrl)
}
