-- S18 profiles and the 18+ attestation gate.
--
-- A profile row is created with the auth user (the first guest session is an anonymous
-- sign-in), unattested. The client then calls public.attest_and_consent with the welcome card's
-- answers (S05a): only the attestation boolean and timestamps are stored, never a birth year.
--
-- Gate convention: every public function that `authenticated` may execute either starts with
-- `v_uid := private.require_attestation();` (or `perform private.require_attestation();`), or is
-- tagged `comment on function ... is '@attestation-exempt: <reason>'`. The catalog integration
-- test enforces this for every function added later.
--
-- RPC errors use PostgREST's custom status codes: SQLSTATE 'PTxyz' becomes HTTP xyz, and the
-- message is a stable machine code (src/lib/supabase/attestation.ts lists them).

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  attested boolean not null default false,
  -- When the player attested on their device (client-supplied, validated by the RPC).
  attested_at timestamptz,
  -- When the server first recorded it.
  attestation_recorded_at timestamptz,
  consent_version text,
  consented_at timestamptz,
  audio_choice text check (audio_choice in ('ours', 'own')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_attested_has_times check (
    attested = (attested_at is not null)
    and attested = (attestation_recorded_at is not null)
  ),
  constraint profiles_consent_pair check ((consent_version is null) = (consented_at is null)),
  constraint profiles_consent_version_format check (consent_version ~ '^\d{4}-\d{2}-\d{2}$')
);

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function private.touch_updated_at();

alter table public.profiles enable row level security;
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

-- Profile creation on sign-up (anonymous or permanent).
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Users who signed up before this migration get their (unattested) profile too.
insert into public.profiles (id) select id from auth.users on conflict (id) do nothing;

-- The gate. Returns the caller's id, or raises 401 (no session) / 403 (not attested).
create function private.require_attestation()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.attested) then
    raise exception 'attestation_required' using errcode = 'PT403';
  end if;
  return v_uid;
end;
$$;

revoke execute on function private.require_attestation() from public, anon, authenticated;

-- Lets a client (and tests) check the gate without side effects.
create function public.assert_attested()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_attestation();
end;
$$;

revoke execute on function public.assert_attested() from public, anon;
grant execute on function public.assert_attested() to authenticated;

create function public.attest_and_consent(
  p_adult boolean,
  p_attested_at timestamptz,
  p_consent_version text,
  p_consented_at timestamptz,
  p_audio_choice text
)
returns public.profiles
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_earliest constant timestamptz := '2026-01-01T00:00:00Z';
  v_row public.profiles;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_adult is distinct from true then
    raise exception 'not_adult' using errcode = 'PT400';
  end if;
  -- Device clocks drift a little; anything further out is not a real answer.
  if p_attested_at is null or p_consented_at is null
    or p_attested_at > now() + interval '5 minutes' or p_attested_at < v_earliest
    or p_consented_at > now() + interval '5 minutes' or p_consented_at < v_earliest then
    raise exception 'invalid_timestamp' using errcode = 'PT400';
  end if;
  if p_consent_version is null or p_consent_version !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  if p_audio_choice is null or p_audio_choice not in ('ours', 'own') then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;

  insert into public.profiles (id) values (v_uid) on conflict (id) do nothing;

  -- The first attestation wins: a later call never moves attested_at. Consent is re-recorded
  -- only when the version changes, so a retry keeps the original consent time.
  update public.profiles p
  set attested = true,
      attested_at = coalesce(p.attested_at, p_attested_at),
      attestation_recorded_at = coalesce(p.attestation_recorded_at, now()),
      consented_at = case
        when p.consent_version is distinct from p_consent_version then p_consented_at
        else p.consented_at
      end,
      consent_version = p_consent_version,
      audio_choice = p_audio_choice
  where p.id = v_uid
  returning p.* into v_row;

  return v_row;
end;
$$;

revoke execute on function public.attest_and_consent(boolean, timestamptz, text, timestamptz, text)
  from public, anon;
grant execute on function public.attest_and_consent(boolean, timestamptz, text, timestamptz, text)
  to authenticated;
comment on function public.attest_and_consent(boolean, timestamptz, text, timestamptz, text) is
  '@attestation-exempt: records the attestation itself';

create function public.set_audio_choice(p_choice text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_choice is null or p_choice not in ('ours', 'own') then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  update public.profiles p set audio_choice = p_choice where p.id = v_uid;
end;
$$;

revoke execute on function public.set_audio_choice(text) from public, anon;
grant execute on function public.set_audio_choice(text) to authenticated;
comment on function public.set_audio_choice(text) is
  '@attestation-exempt: a private sound preference, neither social, realtime nor purchase';
