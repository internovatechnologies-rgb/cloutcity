-- S18 foundation: an unexposed schema for server helpers, and a privilege lockdown.
--
-- Supabase's stock default privileges give anon and authenticated full table privileges and
-- EXECUTE on every new function in public (and Postgres gives PUBLIC EXECUTE on every new
-- function). This project grants every privilege explicitly instead, so a table or function
-- added later is closed until a migration opens it on purpose. The catalog integration test
-- (tests/integration/catalog.test.ts) proves the result.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Functions: no EXECUTE for PUBLIC anywhere (a per-schema default cannot revoke PUBLIC's
-- built-in grant, so this one is global), and none for the client roles in public.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

-- Tables and sequences in public: client roles get only what a migration grants explicitly.
-- service_role keeps its default grants (it bypasses RLS and is server-only).
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

-- Keeps updated_at honest on rows that change.
create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Shared-world features run on city time: the New York calendar day (CLAUDE.md "Two clocks").
create function private.ny_day(ts timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select (ts at time zone 'America/New_York')::date;
$$;

create function private.ny_today()
returns date
language sql
stable
set search_path = ''
as $$
  select private.ny_day(now());
$$;

revoke execute on function private.touch_updated_at() from public, anon, authenticated;
revoke execute on function private.ny_day(timestamptz) from public, anon, authenticated;
revoke execute on function private.ny_today() from public, anon, authenticated;
