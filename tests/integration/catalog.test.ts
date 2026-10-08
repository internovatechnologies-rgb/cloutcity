/**
 * Catalog guards: the privilege model holds for every table and function, including ones a
 * later migration adds. A new table or RPC that forgets RLS, a grant or the attestation gate
 * fails here before it ships.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { newAttestedGuest, newGuest, sql } from './helpers'

/** Tables clients may read (their own or their party's rows, through RLS). */
const CLIENT_READABLE_TABLES = [
  'account_notices',
  'blocks',
  'entitlements',
  'friend_boosts',
  'friendships',
  'grants',
  'live_stats',
  'mutes',
  'profiles',
  'purchases',
  'referrals',
  'roommates',
  'saves',
]

/** Tables only the service role and security-definer functions touch (S18a: handles). */
const SERVICE_ONLY_TABLES = ['handles']

/** Functions allowed to skip the gate, each with a stated reason in its comment. */
const EXEMPT = ['attest_and_consent', 'set_audio_choice', 'set_audio_settings']

/**
 * Client RPCs allowed to skip the standing gate (S18b), each tagged `@standing-exempt: <reason>`
 * on a line of its comment: reads of the caller's own data, and the ways a sanctioned player
 * reports, appeals and acknowledges.
 */
const STANDING_EXEMPT = [
  'acknowledge_notice',
  'assert_attested',
  'attest_and_consent',
  'check_handle',
  'get_my_profile',
  'get_public_profile',
  'get_public_profiles',
  'list_my_blocks',
  'list_my_mutes',
  'list_my_reports',
  'set_audio_choice',
  'set_audio_settings',
  'submit_appeal',
  'submit_report',
]

/** Private tables (S18a, S18b): no client role, and not the service role either, may touch them. */
const PRIVATE_TABLES = [
  'appeals',
  'banned_identities',
  'block_undo',
  'content_holds',
  'handle_changes',
  'handle_settings',
  'handle_terms',
  'handle_words',
  'moderation_audit',
  'moderation_settings',
  'rate_limits',
  'reporter_stats',
  'reports',
  'sanctions',
  'save_history',
  'save_quarantine',
  'save_revisions',
]

/** The moderator actions and console reads (S18b): the /mod server routes call them with the service role. */
const MODERATOR_RPCS = [
  'mod_ban',
  'mod_case',
  'mod_dismiss',
  'mod_queue',
  'mod_reset_handle',
  'mod_resolve_appeal',
  'mod_restrict',
  'mod_set_legal_hold',
  'mod_suspend',
  'mod_warn',
]

const CLIENT_ROLES = ['anon', 'authenticated']
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

async function publicTables(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
    order by 1
  `
  return rows.map((row) => row.name)
}

interface FunctionRow {
  name: string
  schema: string
  oid: number
  definer: boolean
  config: string[] | null
  source: string
  comment: string | null
  /** Input argument names (OUT and TABLE columns left out). */
  args: string[] | null
}

async function functions(schemas: readonly string[]): Promise<FunctionRow[]> {
  return sql<FunctionRow[]>`
    select p.proname as name, n.nspname as schema, p.oid::int as oid, p.prosecdef as definer,
      p.proconfig as config, p.prosrc as source, obj_description(p.oid, 'pg_proc') as comment,
      (
        select array_agg(a.name order by a.ord)
        from unnest(p.proargnames, p.proargmodes::text[]) with ordinality as a(name, mode, ord)
        where coalesce(a.mode, 'i') in ('i', 'b', 'v')
      ) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = any(${schemas as string[]})
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    order by 1
  `
}

/** Public functions the authenticated role (every guest) may call. */
async function clientRpcs(): Promise<FunctionRow[]> {
  const rows = await functions(['public'])
  const callable = await sql<{ oid: number }[]>`
    select p.oid::int as oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
  `
  const oids = new Set(callable.map((row) => row.oid))
  return rows.filter((row) => oids.has(row.oid))
}

const isExempt = (fn: FunctionRow) => /^@attestation-exempt: \S/.test(fn.comment ?? '')
const isStandingExempt = (fn: FunctionRow) => /(?:^|\n)@standing-exempt: \S/.test(fn.comment ?? '')

/** Comments, string literals and dollar-quoted strings: text that is not code. */
const NOT_CODE = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g

/** The first statement after the body's `begin` calls the gate. */
function startsWithGate(source: string): boolean {
  const code = source.replace(NOT_CODE, ' ')
  const begin = /\bbegin\b/i.exec(code)
  if (begin === null) return false
  const body = code.slice(begin.index + begin[0].length).trimStart()
  return /^(?:\w+\s*:=\s*|perform\s+)private\.require_attestation\(\)\s*;/i.test(body)
}

/**
 * The statement right after the attestation gate is the standing gate,
 * `perform private.require_good_standing(v_uid, '<capability>');`, with a known capability.
 */
function callsStandingGate(source: string): boolean {
  const code = source.replace(NOT_CODE, (match) => (match.startsWith("'") ? "''" : ' '))
  const begin = /\bbegin\b/i.exec(code)
  if (begin === null) return false
  const body = code.slice(begin.index + begin[0].length).trimStart()
  const gated =
    /^(?:\w+\s*:=\s*|perform\s+)private\.require_attestation\(\)\s*;\s*perform\s+private\.require_good_standing\(\s*\w+\s*,\s*''\s*\)\s*;/i
  return (
    gated.test(body) &&
    /private\.require_good_standing\(\s*\w+\s*,\s*'(?:interact|social)'\s*\)/.test(source)
  )
}

describe('tables', () => {
  it('every S18 table exists', async () => {
    expect(await publicTables()).toEqual(expect.arrayContaining(CLIENT_READABLE_TABLES))
  })

  it('every service-only table exists', async () => {
    expect(await publicTables()).toEqual(expect.arrayContaining(SERVICE_ONLY_TABLES))
  })

  it('every public table is classified as client-readable or service-only', async () => {
    const known = new Set([...CLIENT_READABLE_TABLES, ...SERVICE_ONLY_TABLES])
    expect((await publicTables()).filter((name) => !known.has(name))).toEqual([])
  })

  it('service-only tables: RLS on, no policies, no client privilege, service role reads', async () => {
    const rows = await sql<
      { name: string; rls: boolean; policies: number; client: boolean; service: boolean }[]
    >`
      select c.relname as name, c.relrowsecurity as rls,
        (select count(*)::int from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname) as policies,
        exists (
          select 1 from unnest(${CLIENT_ROLES}::text[]) as r(role)
          cross join unnest(${['SELECT', ...WRITE_PRIVILEGES]}::text[]) as p(privilege)
          where has_table_privilege(r.role, c.oid, p.privilege)
            or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              and has_any_column_privilege(r.role, c.oid, p.privilege))
        ) as client,
        has_table_privilege('service_role', c.oid, 'SELECT') as service
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any(${SERVICE_ONLY_TABLES})
      order by 1
    `
    expect(rows).toEqual(
      SERVICE_ONLY_TABLES.map((name) => ({
        name,
        rls: true,
        policies: 0,
        client: false,
        service: true,
      })),
    )
  })

  it('every public table has row level security', async () => {
    const rows = await sql<{ name: string }[]>`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    `
    expect(rows).toEqual([])
  })

  it('no public views, which would bypass RLS as their owner', async () => {
    const rows = await sql<{ name: string }[]>`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm')
    `
    expect(rows).toEqual([])
  })

  it('clients have no write privilege on any public table or column', async () => {
    const rows = await sql<{ role: string; name: string; privilege: string }[]>`
      select r.role, c.relname as name, p.privilege
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(${CLIENT_ROLES}::text[]) as r(role)
      cross join unnest(${WRITE_PRIVILEGES}::text[]) as p(privilege)
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and (has_table_privilege(r.role, c.oid, p.privilege)
          or (p.privilege in ('INSERT', 'UPDATE', 'REFERENCES')
            and has_any_column_privilege(r.role, c.oid, p.privilege)))
    `
    expect(rows).toEqual([])
  })

  it('anon reads only live_stats; authenticated reads exactly the client-readable tables', async () => {
    const rows = await sql<{ role: string; name: string }[]>`
      select r.role, c.relname as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(${CLIENT_ROLES}::text[]) as r(role)
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_any_column_privilege(r.role, c.oid, 'SELECT')
      order by 1, 2
    `
    expect(rows.filter((row) => row.role === 'anon').map((row) => row.name)).toEqual(['live_stats'])
    expect(rows.filter((row) => row.role === 'authenticated').map((row) => row.name)).toEqual(
      CLIENT_READABLE_TABLES,
    )
  })

  it('policies only ever grant SELECT (every write is an RPC or the service role)', async () => {
    const rows = await sql<{ table: string; policy: string; cmd: string }[]>`
      select tablename as table, policyname as policy, cmd from pg_policies
      where schemaname = 'public' and cmd <> 'SELECT'
    `
    expect(rows).toEqual([])
  })

  it('every client-readable table has a read policy for authenticated', async () => {
    const rows = await sql<{ table: string }[]>`
      select distinct tablename as table from pg_policies
      where schemaname = 'public' and cmd = 'SELECT' and 'authenticated' = any(roles)
      order by 1
    `
    expect(rows.map((row) => row.table)).toEqual(CLIENT_READABLE_TABLES)
  })

  it('no column stores a birth year or age', async () => {
    const rows = await sql<{ table: string; column: string }[]>`
      select table_name as table, column_name as column from information_schema.columns
      where table_schema = 'public'
        and (column_name ilike '%birth%' or column_name ilike '%year%' or column_name ~* '(^|_)age($|_)')
    `
    expect(rows).toEqual([])
  })

  it('tables and functions a later migration adds start closed to clients', async () => {
    const rollback = new Error('rollback')
    await expect(
      sql.begin(async (tx) => {
        await tx`create table public.s18_probe (id int)`
        await tx`create function public.s18_probe_fn() returns int language sql as 'select 1'`
        const [row] = await tx<{ table: boolean; fn: boolean; publicFn: boolean }[]>`
          select
            has_table_privilege('anon', 'public.s18_probe', 'select')
              or has_table_privilege('authenticated', 'public.s18_probe', 'select')
              or has_table_privilege('authenticated', 'public.s18_probe', 'insert') as table,
            has_function_privilege('anon', 'public.s18_probe_fn()', 'execute')
              or has_function_privilege('authenticated', 'public.s18_probe_fn()', 'execute') as fn,
            exists (
              select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where p.proname = 's18_probe_fn' and a.grantee = 0
            ) as "publicFn"
        `
        expect(row).toEqual({ table: false, fn: false, publicFn: false })
        throw rollback
      }),
    ).rejects.toBe(rollback)
  })
})

describe('functions', () => {
  it('the private schema is closed to clients', async () => {
    const [row] = await sql<{ anon: boolean; auth: boolean }[]>`
      select has_schema_privilege('anon', 'private', 'usage') as anon,
        has_schema_privilege('authenticated', 'private', 'usage') as auth
    `
    expect(row).toEqual({ anon: false, auth: false })
  })

  it('no function in public or private is executable by anon or PUBLIC', async () => {
    const rows = await sql<{ name: string; grantee: string }[]>`
      select p.proname as name, 'anon' as grantee
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')
      union all
      select p.proname, 'PUBLIC'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
        aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname in ('public', 'private') and a.grantee = 0
    `
    expect(rows).toEqual([])
  })

  it('no private helper is executable by authenticated', async () => {
    const rows = await sql<{ name: string }[]>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'execute')
    `
    expect(rows).toEqual([])
  })

  it("every function in public and private pins search_path = ''", async () => {
    const loose = (await functions(['public', 'private']))
      .filter((fn) => !(fn.config ?? []).includes('search_path=""'))
      .map((fn) => `${fn.schema}.${fn.name}`)
    expect(loose).toEqual([])
  })

  it('every security definer function is owned by postgres', async () => {
    const rows = await sql<{ name: string; owner: string }[]>`
      select p.proname as name, pg_get_userbyid(p.proowner) as owner
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
        and pg_get_userbyid(p.proowner) <> 'postgres'
    `
    expect(rows).toEqual([])
  })

  it('the gate scanner reads what it must (self-check)', () => {
    expect(startsWithGate('declare v uuid; begin\n  v_uid := private.require_attestation();')).toBe(
      true,
    )
    expect(startsWithGate('begin perform private.require_attestation(); end')).toBe(true)
    expect(
      startsWithGate('begin if x then null; end if; perform private.require_attestation();'),
    ).toBe(false)
    expect(startsWithGate('select 1')).toBe(false)
    // A `begin` hidden in a comment or a string must not stand in for the body's own.
    expect(
      startsWithGate('/* begin perform private.require_attestation(); */ begin return 1; end'),
    ).toBe(false)
    expect(
      startsWithGate('-- begin v := private.require_attestation();\nbegin return 1; end'),
    ).toBe(false)
    expect(
      startsWithGate(
        "declare s text := 'begin perform private.require_attestation();'; begin return s; end",
      ),
    ).toBe(false)
    expect(
      startsWithGate(
        'declare s text := $x$ begin perform private.require_attestation(); $x$; begin return s; end',
      ),
    ).toBe(false)
  })
})

describe('service-only functions', () => {
  it('commit_save and quarantine_save (S18c) are executable by the service role only', async () => {
    const rows = await sql<{ name: string; anon: boolean; auth: boolean; service: boolean }[]>`
      select p.proname as name,
        has_function_privilege('anon', p.oid, 'execute') as anon,
        has_function_privilege('authenticated', p.oid, 'execute') as auth,
        has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('commit_save', 'quarantine_save')
      order by 1
    `
    expect(rows).toEqual([
      { name: 'commit_save', anon: false, auth: false, service: true },
      { name: 'quarantine_save', anon: false, auth: false, service: true },
    ])
  })

  it('moderator_reset_handle is reachable only through the audited mod_reset_handle (NOTE-15)', async () => {
    const [row] = await sql<{ anon: boolean; auth: boolean; service: boolean }[]>`
      select
        has_function_privilege('anon', 'public.moderator_reset_handle(uuid, text)', 'execute') as anon,
        has_function_privilege('authenticated', 'public.moderator_reset_handle(uuid, text)', 'execute') as auth,
        has_function_privilege('service_role', 'public.moderator_reset_handle(uuid, text)', 'execute') as service
    `
    expect(row).toEqual({ anon: false, auth: false, service: false })
  })

  it('every mod_* RPC is executable by the service role only, and there are no others', async () => {
    const rows = await sql<{ name: string; anon: boolean; auth: boolean; service: boolean }[]>`
      select p.proname as name,
        has_function_privilege('anon', p.oid, 'execute') as anon,
        has_function_privilege('authenticated', p.oid, 'execute') as auth,
        has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'mod\\_%'
      order by 1
    `
    expect(rows).toEqual(
      MODERATOR_RPCS.map((name) => ({ name, anon: false, auth: false, service: true })),
    )
  })

  it('a guest calling a mod_* RPC is refused by PostgREST before it runs', async () => {
    const guest = await newAttestedGuest()
    const client = guest.client as unknown as SupabaseClient
    for (const name of MODERATOR_RPCS) {
      const { error } = await client.rpc(name, {
        p_moderator_id: guest.id,
        p_case: guest.id,
        p_idempotency_key: 'probe-key-0001',
        p_correlation_id: 'probe',
      })
      expect(error, name).not.toBeNull()
      expect(error?.message, name).toMatch(/permission denied|Could not find the function/)
    }
  })
})

describe('private tables', () => {
  it('every private table is known, has RLS on and no privilege for any API role', async () => {
    const rows = await sql<{ name: string; rls: boolean; roles: string[] }[]>`
      select c.relname as name, c.relrowsecurity as rls,
        array(
          select r.role from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
          where has_table_privilege(r.role, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            or has_any_column_privilege(r.role, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
        ) as roles
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'private' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      order by 1
    `
    expect(rows).toEqual(PRIVATE_TABLES.map((name) => ({ name, rls: true, roles: [] })))
  })

  it('moderation_audit: the service role can neither update, delete nor truncate it', async () => {
    const [row] = await sql<Record<string, boolean>[]>`
      select
        has_table_privilege('service_role', 'private.moderation_audit', 'UPDATE') as update,
        has_table_privilege('service_role', 'private.moderation_audit', 'DELETE') as delete,
        has_table_privilege('service_role', 'private.moderation_audit', 'TRUNCATE') as truncate
    `
    expect(row).toEqual({ update: false, delete: false, truncate: false })
  })

  it('moderation_audit is append-only even for its owner (update, delete, truncate all raise)', async () => {
    const [{ id } = { id: 0 }] = await sql<{ id: number }[]>`
      insert into private.moderation_audit (action, moderator_id, case_id, idempotency_key,
        correlation_id, result)
      values ('dismiss', gen_random_uuid(), gen_random_uuid(), ${`catalog-${crypto.randomUUID()}`},
        'catalog', '{}')
      returning id
    `
    await expect(
      sql`update private.moderation_audit set note = 'x' where id = ${id}`,
    ).rejects.toThrow('moderation_audit_append_only')
    await expect(sql`delete from private.moderation_audit where id = ${id}`).rejects.toThrow(
      'moderation_audit_append_only',
    )
    await expect(sql`truncate private.moderation_audit`).rejects.toThrow(
      'moderation_audit_append_only',
    )
  })
})

describe('exposed schemas', () => {
  it('the API exposes only public and graphql_public (the gate scan covers public)', () => {
    const config = readFileSync(resolve(import.meta.dirname, '../../supabase/config.toml'), 'utf8')
    const api = /^\[api\]$([\s\S]*?)^\[/m.exec(config)?.[1] ?? ''
    expect(/^schemas\s*=\s*(\[.*\])$/m.exec(api)?.[1]).toBe('["public", "graphql_public"]')
  })

  it("graphql_public holds only Supabase's graphql entry point, so no RPC hides there", async () => {
    const rows = await sql<{ name: string }[]>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'graphql_public'
    `
    expect(rows.map((row) => row.name)).toEqual(['graphql'])
  })
})

describe('attestation gate: default deny', () => {
  it('every client RPC calls the gate first, or carries a stated exemption', async () => {
    const rpcs = await clientRpcs()
    expect(rpcs.map((fn) => fn.name)).toEqual(
      expect.arrayContaining([
        'assert_attested',
        'send_friend_boost',
        'get_my_profile',
        'check_handle',
        'set_handle',
        'get_public_profile',
        'get_public_profiles',
        ...EXEMPT,
      ]),
    )
    const ungated = rpcs
      .filter((fn) => !isExempt(fn) && !startsWithGate(fn.source))
      .map((fn) => fn.name)
    expect(ungated).toEqual([])
    expect(rpcs.filter(isExempt).map((fn) => fn.name)).toEqual(EXEMPT)
  })

  it('every gated client RPC refuses an unattested guest', async () => {
    const guest = await newGuest()
    const client = guest.client as unknown as SupabaseClient
    const gated = (await clientRpcs()).filter((fn) => !isExempt(fn))
    expect(gated.length).toBeGreaterThan(0)
    for (const fn of gated) {
      const args = Object.fromEntries((fn.args ?? []).map((name) => [name, null]))
      const { error } = await client.rpc(fn.name, args)
      expect(error?.message, fn.name).toBe('attestation_required')
    }
  })
})

describe('standing gate: default deny (S18b)', () => {
  it('every client RPC calls the standing gate right after the attestation gate, or is tagged', async () => {
    const rpcs = await clientRpcs()
    expect(rpcs.map((fn) => fn.name)).toEqual(
      expect.arrayContaining([
        'block_player',
        'unblock_player',
        'mute_player',
        'unmute_player',
        'send_friend_boost',
        'set_handle',
        ...STANDING_EXEMPT,
      ]),
    )
    const ungated = rpcs
      .filter((fn) => !isStandingExempt(fn) && !callsStandingGate(fn.source))
      .map((fn) => fn.name)
    expect(ungated).toEqual([])
    expect(rpcs.filter(isStandingExempt).map((fn) => fn.name)).toEqual(STANDING_EXEMPT)
  })

  it('the standing scanner reads what it must (self-check)', () => {
    const gate = 'v_uid := private.require_attestation();'
    expect(
      callsStandingGate(`begin ${gate} perform private.require_good_standing(v_uid, 'social');`),
    ).toBe(true)
    expect(callsStandingGate(`begin ${gate} return 1; end`)).toBe(false)
    expect(
      callsStandingGate(`begin ${gate} perform private.require_good_standing(v_uid, 'anything');`),
    ).toBe(false)
    expect(
      callsStandingGate(
        `begin ${gate} if x then null; end if; perform private.require_good_standing(v_uid, 'social');`,
      ),
    ).toBe(false)
    expect(
      callsStandingGate(
        `begin ${gate} -- perform private.require_good_standing(v_uid, 'social');\nreturn 1;`,
      ),
    ).toBe(false)
  })
})
