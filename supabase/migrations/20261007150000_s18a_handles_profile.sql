-- S18a handles and the public profile.
--
-- Every attested player gets a generated handle (AdjectiveNoun##) the moment they attest, and may
-- choose their own: filtered server-side for slurs, profanity, reserved/staff/brand/agency names
-- and impersonation, unique case- and underscore-insensitively, and limited on change. Released
-- handles are quarantined; a handle a moderator takes away is retired for good.
--
-- The public profile is exactly four fields: handle, public_level, career_path and avatar
-- (INT-10). S18c's commit_save (service role) is the only writer of the last three; here they get
-- safe defaults. Other players read them only through get_public_profile(s), never the table.
--
-- The handle rules, the guest-handle words and the blocklist live in /data; the generated block
-- near the end copies them in (scripts/moderation/blocklist-sql.ts, checked by its test). The
-- format pattern in private.handle_format_ok is src/lib/handles/normalise.ts handlePattern()
-- (checked by src/lib/handles/parity.test.ts).

-- Settings, words and terms from /data (seeded below).
create table private.handle_settings (
  key text primary key check (key ~ '^[A-Za-z.]+$'),
  value integer not null
);

create table private.handle_words (
  kind text not null check (kind in ('adjective', 'noun')),
  word text not null check (word ~ '^[A-Z][a-z]{2,6}$'),
  primary key (kind, word)
);

create table private.handle_terms (
  mode text not null check (mode in ('contains', 'exact', 'allow')),
  term text not null check (term ~ '^[a-z0-9]{2,40}$'),
  -- The term with repeated letters collapsed: equal to `term` when it has no repeats.
  squeezed text generated always as (regexp_replace(term, '(.)\1+', '\1', 'g')) stored,
  primary key (mode, term)
);

-- One row per handle ever used, keyed so that case and underscores never make two handles
-- different. Service role only: clients see handles through the profile RPCs.
create table public.handles (
  handle_key text primary key,
  handle text not null,
  -- Kept on release (the owner may take it back during quarantine); null once the account is
  -- deleted.
  user_id uuid references public.profiles (id) on delete set null,
  source text not null check (source in ('generated', 'chosen')),
  claimed_at timestamptz not null default now(),
  released_at timestamptz,
  quarantine_until timestamptz,
  -- Set when a moderator takes the handle away: it can never be claimed again.
  retired_at timestamptz,
  retired_reason text check (char_length(retired_reason) between 1 and 280),
  constraint handles_key_matches check (handle_key = lower(replace(handle, '_', ''))),
  constraint handles_active_has_owner check (released_at is not null or user_id is not null),
  -- Active: nothing set. Released: either quarantined until a time, or retired with a reason.
  constraint handles_release_state check (
    (released_at is null and quarantine_until is null and retired_at is null)
    or (
      released_at is not null
      and (quarantine_until is null) = (retired_at is not null)
    )
  ),
  constraint handles_retired_reason check ((retired_at is null) = (retired_reason is null))
);

-- One active handle per player.
create unique index handles_one_active_per_user on public.handles (user_id)
  where released_at is null;
create index handles_user_id_idx on public.handles (user_id);

alter table public.handles enable row level security;
revoke all on table public.handles from anon, authenticated;

-- Changes the player chose (generated handles and moderator resets are not changes).
create table private.handle_changes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  changed_at timestamptz not null default now(),
  -- The first changes are free (handles.json changes.freeChanges) and never count to the limit.
  free boolean not null
);

create index handle_changes_user_changed_idx on private.handle_changes (user_id, changed_at desc);

-- Fixed-window counters for any per-player rate limit (private.consume_rate_limit).
create table private.rate_limits (
  user_id uuid not null references public.profiles (id) on delete cascade,
  bucket text not null check (bucket ~ '^[A-Za-z][A-Za-z_.]*$'),
  window_started_at timestamptz not null,
  hits integer not null check (hits > 0),
  primary key (user_id, bucket)
);

alter table private.handle_settings enable row level security;
alter table private.handle_words enable row level security;
alter table private.handle_terms enable row level security;
alter table private.handle_changes enable row level security;
alter table private.rate_limits enable row level security;
revoke all on table private.handle_settings, private.handle_words, private.handle_terms,
  private.handle_changes, private.rate_limits from public, anon, authenticated;

-- Pure helpers. Each has a TypeScript twin in src/lib/handles/.
create function private.handle_key(p_handle text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(replace(p_handle, '_', ''));
$$;

-- Same pattern as handlePattern() in src/lib/handles/normalise.ts for data/config/handles.json:
-- 3-16 ASCII letters, digits and underscores, a letter first, at least 2 letters, no double
-- or trailing underscore.
create function private.handle_format_ok(p_handle text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_handle ~ '^(?=.{3,16}$)(?=(?:[^A-Za-z]*[A-Za-z]){2})[A-Za-z](?:_?[A-Za-z0-9])*$',
    false
  );
$$;

-- What the filter compares: lower case, no underscores, leetspeak digits read as letters.
create function private.handle_skeleton(p_handle text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(lower(p_handle), '01345789_', 'oieastbg');
$$;

create function private.handle_squeeze(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(p_text, '(.)\1+', '\1', 'g');
$$;

create function private.handle_setting(p_key text)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  v_value integer;
begin
  select s.value into v_value from private.handle_settings s where s.key = p_key;
  if v_value is null then
    raise exception 'missing handle setting %', p_key using errcode = 'P0001';
  end if;
  return v_value;
end;
$$;

-- The filter (twin: handleAllowed in src/lib/handles/filter.ts). Exact terms refuse the whole
-- handle, with or without trailing digits; contains terms refuse it anywhere once allowlisted
-- words (badminton, cocktail) are taken out. Squeezed forms catch stretched letters, compared
-- only with terms that have no repeats of their own.
create function private.handle_allowed(p_handle text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_skeleton text;
  v_bare text;
  v_raw text;
  v_squeezed text;
  v_word text;
begin
  if p_handle is null then
    return false;
  end if;
  v_skeleton := private.handle_skeleton(p_handle);
  v_bare := private.handle_skeleton(regexp_replace(p_handle, '[0-9_]+$', ''));

  if exists (
    select 1 from private.handle_terms t
    where t.mode = 'exact'
      and (
        t.term in (v_skeleton, v_bare)
        or (
          t.term = t.squeezed
          and t.term in (private.handle_squeeze(v_skeleton), private.handle_squeeze(v_bare))
        )
      )
  ) then
    return false;
  end if;

  v_raw := v_skeleton;
  v_squeezed := private.handle_squeeze(v_skeleton);
  -- A space is never part of a term, so no term can straddle a removed word.
  for v_word in
    select t.term from private.handle_terms t
    where t.mode = 'allow'
    order by length(t.term) desc, t.term collate "C"
  loop
    v_raw := replace(v_raw, v_word, ' ');
    v_squeezed := replace(v_squeezed, private.handle_squeeze(v_word), ' ');
  end loop;

  return not exists (
    select 1 from private.handle_terms t
    where t.mode = 'contains'
      and (strpos(v_raw, t.term) > 0 or (t.term = t.squeezed and strpos(v_squeezed, t.term) > 0))
  );
end;
$$;

-- Profile columns. The public projection (INT-10): S18c's commit_save is the only writer of
-- public_level, career_path and avatar (owned plus entitled cosmetic ids), so the defaults show
-- a new player as a Nobody with no path and the default look.
alter table public.profiles
  add column handle text,
  add column public_level text not null default 'nobody',
  add column career_path text,
  add column avatar jsonb not null default '{}'::jsonb,
  add constraint profiles_handle_format check (handle is null or private.handle_format_ok(handle)),
  add constraint profiles_attested_has_handle check (handle is null or attested),
  -- The clout ladder ids (data/config/balance.json clout.levels; parity.test.ts checks them).
  add constraint profiles_public_level_known check (
    public_level in ('nobody', 'local', 'scene-regular', 'known', 'famous', 'icon')
  ),
  add constraint profiles_career_path_format check (
    career_path is null or career_path ~ '^[a-z][a-z0-9-]{0,31}$'
  ),
  add constraint profiles_avatar_shape check (
    jsonb_typeof(avatar) = 'object' and octet_length(avatar::text) <= 4096
  );

-- A second guard on uniqueness, should the two tables ever disagree.
create unique index profiles_handle_key on public.profiles (private.handle_key(handle))
  where handle is not null;

-- Counts one call against a per-player fixed window; raises 429 once `p_max` is used up. The
-- refused call's increment rolls back with it, so the counter rests at the limit.
create function private.consume_rate_limit(
  p_uid uuid,
  p_bucket text,
  p_max integer,
  p_window interval
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hits integer;
begin
  insert into private.rate_limits as r (user_id, bucket, window_started_at, hits)
  values (p_uid, p_bucket, now(), 1)
  on conflict (user_id, bucket) do update
  set hits = case when r.window_started_at <= now() - p_window then 1 else r.hits + 1 end,
      window_started_at = case
        when r.window_started_at <= now() - p_window then now()
        else r.window_started_at
      end
  returning r.hits into v_hits;

  if v_hits > p_max then
    raise exception 'rate_limited' using errcode = 'PT429';
  end if;
end;
$$;

-- A limit from handles.json `rateLimits.<name>` ({max, windowMs}).
create function private.consume_handle_rate_limit(p_uid uuid, p_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.consume_rate_limit(
    p_uid,
    p_name,
    private.handle_setting('rateLimits.' || p_name || '.max'),
    make_interval(secs => private.handle_setting('rateLimits.' || p_name || '.windowMs') / 1000.0)
  );
end;
$$;

-- Gives the player a fresh AdjectiveNoun## handle (or returns the one they hold). Two-digit
-- numbers first; if those keep colliding or failing the filter, longer ones that still fit.
create function private.claim_generated_handle(p_uid uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_attempts integer := private.handle_setting('generated.attempts');
  v_max_length integer := private.handle_setting('maxLength');
  v_digits integer;
  v_candidate text;
begin
  select h.handle into v_candidate
  from public.handles h
  where h.user_id = p_uid and h.released_at is null;
  if v_candidate is not null then
    return v_candidate;
  end if;

  for i in 1 .. v_attempts * 2 loop
    v_digits := private.handle_setting(
      case when i <= v_attempts then 'generated.digits' else 'generated.fallbackDigits' end
    );
    v_candidate :=
      (select w.word from private.handle_words w where w.kind = 'adjective' order by random() limit 1)
      || (select w.word from private.handle_words w where w.kind = 'noun' order by random() limit 1)
      || (10 ^ (v_digits - 1) + floor(random() * 9 * 10 ^ (v_digits - 1)))::bigint::text;
    continue when length(v_candidate) > v_max_length
      or not private.handle_format_ok(v_candidate)
      or not private.handle_allowed(v_candidate);

    -- A key ever used (active, quarantined or retired) is never handed out again.
    insert into public.handles (handle_key, handle, user_id, source)
    values (private.handle_key(v_candidate), v_candidate, p_uid, 'generated')
    on conflict (handle_key) do nothing;
    if found then
      return v_candidate;
    end if;
  end loop;

  raise exception 'handle_generation_failed' using errcode = 'P0001';
end;
$$;

-- The player's handle, generating one if they have none. Locks the profile row.
create function private.ensure_handle(p_uid uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_handle text;
begin
  select p.handle into v_handle from public.profiles p where p.id = p_uid for update;
  if not found then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;
  if v_handle is not null then
    return v_handle;
  end if;
  v_handle := private.claim_generated_handle(p_uid);
  update public.profiles p set handle = v_handle where p.id = p_uid;
  return v_handle;
end;
$$;

-- Moves a chosen handle to the player, releasing (and quarantining) the one they held. The
-- caller holds the player's profile row lock. Raises handle_taken (409) when someone else holds
-- it, it is quarantined for someone else, or it is retired.
create function private.claim_handle(p_uid uuid, p_handle text, p_source text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := private.handle_key(p_handle);
  v_row public.handles;
  v_claimable boolean;
begin
  select h.* into v_row from public.handles h where h.handle_key = v_key for update;
  if v_row.handle_key is not null then
    v_claimable := coalesce(
      (v_row.released_at is null and v_row.user_id = p_uid)
      or (
        v_row.released_at is not null
        and v_row.retired_at is null
        and (v_row.user_id = p_uid or v_row.quarantine_until <= now())
      ),
      false
    );
    if not v_claimable then
      raise exception 'handle_taken' using errcode = 'PT409';
    end if;
  end if;

  update public.handles h
  set released_at = now(),
      quarantine_until = now() + make_interval(days => private.handle_setting('quarantineDays'))
  where h.user_id = p_uid and h.released_at is null and h.handle_key <> v_key;

  if v_row.handle_key is not null then
    update public.handles h
    set handle = p_handle, user_id = p_uid, source = p_source, claimed_at = now(),
        released_at = null, quarantine_until = null
    where h.handle_key = v_key;
  else
    insert into public.handles (handle_key, handle, user_id, source)
    values (v_key, p_handle, p_uid, p_source)
    on conflict (handle_key) do nothing;
    if not found then
      raise exception 'handle_taken' using errcode = 'PT409';
    end if;
  end if;
end;
$$;

-- Whether the player may change their handle now, and if not, when.
create function private.handle_change_status(p_uid uuid)
returns table (free_change boolean, changes_left integer, next_change_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_in_window integer;
  v_last timestamptz;
  v_slot timestamptz;
  v_window interval := make_interval(days => private.handle_setting('changes.windowDays'));
  v_per_window integer := private.handle_setting('changes.perWindow');
begin
  select count(*)::integer, max(c.changed_at) into v_total, v_last
  from private.handle_changes c where c.user_id = p_uid;

  if v_total < private.handle_setting('changes.freeChanges') then
    free_change := true;
    changes_left := v_per_window;
    next_change_at := null;
    return next;
    return;
  end if;

  select count(*)::integer into v_in_window
  from private.handle_changes c
  where c.user_id = p_uid and not c.free and c.changed_at > now() - v_window;

  -- With the window full, a slot opens when the perWindow-th most recent change leaves it.
  if v_in_window >= v_per_window then
    select c.changed_at + v_window into v_slot
    from private.handle_changes c
    where c.user_id = p_uid and not c.free and c.changed_at > now() - v_window
    order by c.changed_at desc
    offset v_per_window - 1
    limit 1;
  end if;

  free_change := false;
  changes_left := greatest(v_per_window - v_in_window, 0);
  next_change_at := greatest(
    v_last + make_interval(hours => private.handle_setting('changes.minIntervalHours')),
    v_slot
  );
  if next_change_at <= now() then
    next_change_at := null;
  end if;
  return next;
end;
$$;

-- The caller's own profile, as get_my_profile and set_handle return it.
create function private.my_profile(p_uid uuid)
returns table (
  handle text,
  public_level text,
  career_path text,
  avatar jsonb,
  handle_generated boolean,
  free_handle_change boolean,
  handle_changes_left integer,
  next_handle_change_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.handle, p.public_level, p.career_path, p.avatar,
    coalesce(h.source = 'generated', false),
    s.free_change, s.changes_left, s.next_change_at
  from public.profiles p
  left join public.handles h on h.user_id = p.id and h.released_at is null
  cross join private.handle_change_status(p.id) s
  where p.id = p_uid;
$$;

-- Visibility stub for S18b: blocks (either way) will make this false. Until then any attested
-- player is visible to any other.
create function private.can_view(p_viewer uuid, p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null and exists (
    select 1 from public.profiles p where p.id = p_target and p.attested
  );
$$;

-- The handle other players may see for a user (null when they have none), for S18b's surfaces.
create function private.public_handle(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.handle from public.profiles p where p.id = p_uid and p.attested;
$$;

revoke execute on function private.handle_key(text) from public, anon, authenticated;
revoke execute on function private.handle_format_ok(text) from public, anon, authenticated;
revoke execute on function private.handle_skeleton(text) from public, anon, authenticated;
revoke execute on function private.handle_squeeze(text) from public, anon, authenticated;
revoke execute on function private.handle_setting(text) from public, anon, authenticated;
revoke execute on function private.handle_allowed(text) from public, anon, authenticated;
revoke execute on function private.consume_rate_limit(uuid, text, integer, interval)
  from public, anon, authenticated;
revoke execute on function private.consume_handle_rate_limit(uuid, text)
  from public, anon, authenticated;
revoke execute on function private.claim_generated_handle(uuid) from public, anon, authenticated;
revoke execute on function private.ensure_handle(uuid) from public, anon, authenticated;
revoke execute on function private.claim_handle(uuid, text, text) from public, anon, authenticated;
revoke execute on function private.handle_change_status(uuid) from public, anon, authenticated;
revoke execute on function private.my_profile(uuid) from public, anon, authenticated;
revoke execute on function private.can_view(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.public_handle(uuid) from public, anon, authenticated;

-- A player gets their generated handle the moment they attest (inside attest_and_consent, so
-- its returned row already carries it). Repeat attestations keep the handle.
create function private.profiles_assign_handle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.handle := private.claim_generated_handle(new.id);
  return new;
end;
$$;

create trigger profiles_assign_handle
  before update of attested on public.profiles
  for each row when (new.attested and new.handle is null)
  execute function private.profiles_assign_handle();

-- A profile inserted already attested (service role) gets one too; the row must exist first.
create function private.profiles_assign_handle_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.ensure_handle(new.id);
  return null;
end;
$$;

create trigger profiles_assign_handle_on_insert
  after insert on public.profiles
  for each row when (new.attested and new.handle is null)
  execute function private.profiles_assign_handle_on_insert();

-- A deleted account's handle is quarantined like any released one, so nobody can step into a
-- name other players know.
create function private.profiles_release_handle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.handles h
  set released_at = now(),
      quarantine_until = now() + make_interval(days => private.handle_setting('quarantineDays'))
  where h.user_id = old.id and h.released_at is null;
  return old;
end;
$$;

create trigger profiles_release_handle
  before delete on public.profiles
  for each row execute function private.profiles_release_handle();

revoke execute on function private.profiles_assign_handle() from public, anon, authenticated;
revoke execute on function private.profiles_assign_handle_on_insert()
  from public, anon, authenticated;
revoke execute on function private.profiles_release_handle() from public, anon, authenticated;

-- Client RPCs. Each starts with the attestation gate.

create function public.get_my_profile()
returns table (
  handle text,
  public_level text,
  career_path text,
  avatar jsonb,
  handle_generated boolean,
  free_handle_change boolean,
  handle_changes_left integer,
  next_handle_change_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  v_uid := private.require_attestation();
  return query select * from private.my_profile(v_uid);
end;
$$;

-- Live availability for the handle form: 'available', 'current' (the caller's own handle),
-- 'taken' (held, quarantined or retired), 'invalid' (format) or 'not_allowed' (filter).
create function public.check_handle(p_handle text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.handles;
begin
  v_uid := private.require_attestation();
  perform private.consume_handle_rate_limit(v_uid, 'checkHandle');
  if not private.handle_format_ok(p_handle) then
    return 'invalid';
  end if;
  if not private.handle_allowed(p_handle) then
    return 'not_allowed';
  end if;

  select h.* into v_row from public.handles h where h.handle_key = private.handle_key(p_handle);
  if v_row.handle_key is null then
    return 'available';
  end if;
  if v_row.released_at is null and v_row.user_id = v_uid then
    return case when v_row.handle = p_handle then 'current' else 'available' end;
  end if;
  if v_row.released_at is not null and v_row.retired_at is null
    and (v_row.user_id = v_uid or v_row.quarantine_until <= now()) then
    return 'available';
  end if;
  return 'taken';
end;
$$;

-- Sets the caller's handle exactly as given (the form previews any normalisation first, GR-6).
create function public.set_handle(p_handle text)
returns table (
  handle text,
  public_level text,
  career_path text,
  avatar jsonb,
  handle_generated boolean,
  free_handle_change boolean,
  handle_changes_left integer,
  next_handle_change_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
  v_current text;
  v_status record;
begin
  v_uid := private.require_attestation();
  perform private.consume_handle_rate_limit(v_uid, 'checkHandle');
  if not private.handle_format_ok(p_handle) then
    raise exception 'handle_invalid' using errcode = 'PT400';
  end if;
  if not private.handle_allowed(p_handle) then
    raise exception 'handle_not_allowed' using errcode = 'PT400';
  end if;

  -- Serialises this player's changes, so the limits below cannot be raced.
  select p.handle into v_current from public.profiles p where p.id = v_uid for update;
  if v_current is distinct from p_handle then
    select * into v_status from private.handle_change_status(v_uid);
    if v_status.next_change_at is not null then
      raise exception 'handle_change_limited' using errcode = 'PT429';
    end if;

    begin
      perform private.claim_handle(v_uid, p_handle, 'chosen');
    exception when unique_violation then
      raise exception 'handle_taken' using errcode = 'PT409';
    end;

    insert into private.handle_changes (user_id, free) values (v_uid, v_status.free_change);
    update public.profiles p set handle = p_handle where p.id = v_uid;
  end if;

  return query select * from private.my_profile(v_uid);
end;
$$;

-- One player's public profile by handle. Unknown, released and hidden handles all get the same
-- 404, so the RPC cannot be used to learn who exists or who blocked whom.
create function public.get_public_profile(p_handle text)
returns table (handle text, public_level text, career_path text, avatar jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
begin
  v_uid := private.require_attestation();
  perform private.consume_handle_rate_limit(v_uid, 'publicProfile');
  return query
    select p.handle, p.public_level, p.career_path, p.avatar
    from public.handles h
    join public.profiles p on p.id = h.user_id
    where h.handle_key = private.handle_key(coalesce(p_handle, ''))
      and h.released_at is null
      and p.attested
      and p.handle is not null
      and private.can_view(v_uid, p.id);
  if not found then
    raise exception 'profile_not_found' using errcode = 'PT404';
  end if;
end;
$$;

-- Public profiles for player ids seen in the city (presence carries ids only). Ids that are
-- unknown or hidden are left out, the same for both.
create function public.get_public_profiles(p_ids uuid[])
returns table (id uuid, handle text, public_level text, career_path text, avatar jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
begin
  v_uid := private.require_attestation();
  if p_ids is null then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  if cardinality(p_ids) > private.handle_setting('publicProfilesMaxIds') then
    raise exception 'too_many_ids' using errcode = 'PT400';
  end if;
  perform private.consume_handle_rate_limit(v_uid, 'publicProfile');
  return query
    select p.id, p.handle, p.public_level, p.career_path, p.avatar
    from public.profiles p
    where p.id = any (p_ids)
      and p.attested
      and p.handle is not null
      and private.can_view(v_uid, p.id)
    order by p.id;
end;
$$;

-- Service role only (S18b's /mod routes, which also write the audit row): retires the player's
-- handle for good and gives them a fresh generated one. Not a change the player made, so it
-- uses none of their allowance.
create function public.moderator_reset_handle(p_user_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_attested boolean;
  v_handle text;
begin
  if p_user_id is null or p_reason is null or char_length(btrim(p_reason)) not between 1 and 280
  then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  select p.attested into v_attested from public.profiles p where p.id = p_user_id for update;
  if v_attested is distinct from true then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;

  update public.handles h
  set released_at = now(), quarantine_until = null, retired_at = now(),
      retired_reason = btrim(p_reason)
  where h.user_id = p_user_id and h.released_at is null;

  v_handle := private.claim_generated_handle(p_user_id);
  update public.profiles p set handle = v_handle where p.id = p_user_id;
  return v_handle;
end;
$$;

revoke execute on function public.get_my_profile() from public, anon;
grant execute on function public.get_my_profile() to authenticated;
revoke execute on function public.check_handle(text) from public, anon;
grant execute on function public.check_handle(text) to authenticated;
revoke execute on function public.set_handle(text) from public, anon;
grant execute on function public.set_handle(text) to authenticated;
revoke execute on function public.get_public_profile(text) from public, anon;
grant execute on function public.get_public_profile(text) to authenticated;
revoke execute on function public.get_public_profiles(uuid[]) from public, anon;
grant execute on function public.get_public_profiles(uuid[]) to authenticated;
revoke execute on function public.moderator_reset_handle(uuid, text)
  from public, anon, authenticated;
grant execute on function public.moderator_reset_handle(uuid, text) to service_role;

-- The /data copies (handle rules, guest-handle words, blocklist).
-- BEGIN GENERATED handle seed (npm run handles:sql; do not edit by hand)
insert into private.handle_settings (key, value) values
  ('minLength', 3),
  ('maxLength', 16),
  ('minLetters', 2),
  ('generated.digits', 2),
  ('generated.fallbackDigits', 4),
  ('generated.attempts', 20),
  ('changes.freeChanges', 1),
  ('changes.perWindow', 2),
  ('changes.windowDays', 30),
  ('changes.minIntervalHours', 24),
  ('quarantineDays', 30),
  ('rateLimits.checkHandle.max', 30),
  ('rateLimits.checkHandle.windowMs', 60000),
  ('rateLimits.publicProfile.max', 120),
  ('rateLimits.publicProfile.windowMs', 60000),
  ('publicProfilesMaxIds', 50);
insert into private.handle_words (kind, word) values
  ('adjective', 'Bold'),
  ('adjective', 'Brave'),
  ('adjective', 'Bright'),
  ('adjective', 'Brisk'),
  ('adjective', 'Calm'),
  ('adjective', 'Chill'),
  ('adjective', 'Clever'),
  ('adjective', 'Cosmic'),
  ('adjective', 'Cozy'),
  ('adjective', 'Crisp'),
  ('adjective', 'Dapper'),
  ('adjective', 'Eager'),
  ('adjective', 'Epic'),
  ('adjective', 'Fancy'),
  ('adjective', 'Fizzy'),
  ('adjective', 'Flashy'),
  ('adjective', 'Fresh'),
  ('adjective', 'Frosty'),
  ('adjective', 'Funky'),
  ('adjective', 'Giddy'),
  ('adjective', 'Glossy'),
  ('adjective', 'Golden'),
  ('adjective', 'Grand'),
  ('adjective', 'Groovy'),
  ('adjective', 'Happy'),
  ('adjective', 'Humble'),
  ('adjective', 'Hyped'),
  ('adjective', 'Jazzy'),
  ('adjective', 'Jolly'),
  ('adjective', 'Keen'),
  ('adjective', 'Lively'),
  ('adjective', 'Loud'),
  ('adjective', 'Lucky'),
  ('adjective', 'Mellow'),
  ('adjective', 'Mighty'),
  ('adjective', 'Misty'),
  ('adjective', 'Neon'),
  ('adjective', 'Nifty'),
  ('adjective', 'Noble'),
  ('adjective', 'Peppy'),
  ('adjective', 'Plucky'),
  ('adjective', 'Proud'),
  ('adjective', 'Quick'),
  ('adjective', 'Quiet'),
  ('adjective', 'Rapid'),
  ('adjective', 'Royal'),
  ('adjective', 'Savvy'),
  ('adjective', 'Shiny'),
  ('adjective', 'Sleek'),
  ('adjective', 'Slick'),
  ('adjective', 'Smooth'),
  ('adjective', 'Snappy'),
  ('adjective', 'Sonic'),
  ('adjective', 'Speedy'),
  ('adjective', 'Steady'),
  ('adjective', 'Stellar'),
  ('adjective', 'Sunny'),
  ('adjective', 'Swift'),
  ('adjective', 'Uptown'),
  ('adjective', 'Witty'),
  ('noun', 'Bagel'),
  ('noun', 'Bodega'),
  ('noun', 'Borough'),
  ('noun', 'Bridge'),
  ('noun', 'Cabbie'),
  ('noun', 'Deli'),
  ('noun', 'Ferry'),
  ('noun', 'Hydrant'),
  ('noun', 'Pretzel'),
  ('noun', 'Pigeon'),
  ('noun', 'Subway'),
  ('noun', 'Taxi'),
  ('noun', 'Skyline'),
  ('noun', 'Stoop'),
  ('noun', 'Rooftop'),
  ('noun', 'Avenue'),
  ('noun', 'Block'),
  ('noun', 'Metro'),
  ('noun', 'Token'),
  ('noun', 'Express'),
  ('noun', 'Harbor'),
  ('noun', 'Pier'),
  ('noun', 'Island'),
  ('noun', 'Garden'),
  ('noun', 'Plaza'),
  ('noun', 'Tower'),
  ('noun', 'Jazz'),
  ('noun', 'Beat'),
  ('noun', 'Rhythm'),
  ('noun', 'Mixtape'),
  ('noun', 'Vinyl'),
  ('noun', 'Record'),
  ('noun', 'Hustle'),
  ('noun', 'Dreamer'),
  ('noun', 'Rider'),
  ('noun', 'Runner'),
  ('noun', 'Skater'),
  ('noun', 'Dancer'),
  ('noun', 'Poet'),
  ('noun', 'Artist'),
  ('noun', 'Coder'),
  ('noun', 'Founder'),
  ('noun', 'Legend'),
  ('noun', 'Star'),
  ('noun', 'Comet'),
  ('noun', 'Rocket'),
  ('noun', 'Falcon'),
  ('noun', 'Hawk'),
  ('noun', 'Fox'),
  ('noun', 'Tiger'),
  ('noun', 'Beacon'),
  ('noun', 'Lantern'),
  ('noun', 'Slice'),
  ('noun', 'Knish'),
  ('noun', 'Cannoli'),
  ('noun', 'Noodle'),
  ('noun', 'Sneaker'),
  ('noun', 'Hoodie'),
  ('noun', 'Boombox'),
  ('noun', 'Mural');
insert into private.handle_terms (mode, term) values
  ('allow', 'auspicious'),
  ('allow', 'badminton'),
  ('allow', 'cockatoo'),
  ('allow', 'cockney'),
  ('allow', 'cockpit'),
  ('allow', 'cockroach'),
  ('allow', 'cocktail'),
  ('allow', 'cocky'),
  ('allow', 'cocoon'),
  ('allow', 'conspicuous'),
  ('allow', 'despicable'),
  ('allow', 'dickens'),
  ('allow', 'dickinson'),
  ('allow', 'drape'),
  ('allow', 'draping'),
  ('allow', 'dyker'),
  ('allow', 'essex'),
  ('allow', 'flagstaff'),
  ('allow', 'gamecock'),
  ('allow', 'grape'),
  ('allow', 'hancock'),
  ('allow', 'heroine'),
  ('allow', 'middlesex'),
  ('allow', 'montenegro'),
  ('allow', 'negroni'),
  ('allow', 'parapet'),
  ('allow', 'peacock'),
  ('allow', 'raccoon'),
  ('allow', 'retardant'),
  ('allow', 'scrape'),
  ('allow', 'scraping'),
  ('allow', 'scunthorpe'),
  ('allow', 'sexton'),
  ('allow', 'shuttlecock'),
  ('allow', 'skeeter'),
  ('allow', 'skyscraper'),
  ('allow', 'spice'),
  ('allow', 'spiced'),
  ('allow', 'spicy'),
  ('allow', 'spunky'),
  ('allow', 'sussex'),
  ('allow', 'therapist'),
  ('allow', 'thorny'),
  ('allow', 'trapeze'),
  ('allow', 'trimming'),
  ('allow', 'twinkle'),
  ('allow', 'twinkling'),
  ('allow', 'twitchy'),
  ('allow', 'tycoon'),
  ('allow', 'wessex'),
  ('allow', 'woodcock'),
  ('contains', '2girlsicup'),
  ('contains', 'acrotomophilia'),
  ('contains', 'admin'),
  ('contains', 'alabamahotpocket'),
  ('contains', 'alaskanpipeline'),
  ('contains', 'anilingus'),
  ('contains', 'anthropic'),
  ('contains', 'apeshit'),
  ('contains', 'arsehole'),
  ('contains', 'asshole'),
  ('contains', 'assmunch'),
  ('contains', 'autoerotic'),
  ('contains', 'babeland'),
  ('contains', 'babybatter'),
  ('contains', 'babyjuice'),
  ('contains', 'ballgag'),
  ('contains', 'ballgravy'),
  ('contains', 'ballkicking'),
  ('contains', 'balllicking'),
  ('contains', 'ballsack'),
  ('contains', 'ballsucking'),
  ('contains', 'bangbros'),
  ('contains', 'bangbus'),
  ('contains', 'bareback'),
  ('contains', 'barelylegal'),
  ('contains', 'bastard'),
  ('contains', 'bastardo'),
  ('contains', 'bastinado'),
  ('contains', 'bdsm'),
  ('contains', 'beaner'),
  ('contains', 'beaners'),
  ('contains', 'beastiality'),
  ('contains', 'beavercleaver'),
  ('contains', 'beaverlips'),
  ('contains', 'bestiality'),
  ('contains', 'bigbreasts'),
  ('contains', 'bigknockers'),
  ('contains', 'bigtits'),
  ('contains', 'bimbos'),
  ('contains', 'birdlock'),
  ('contains', 'bitch'),
  ('contains', 'bitches'),
  ('contains', 'blackcock'),
  ('contains', 'blondeaction'),
  ('contains', 'blondeonblondeaction'),
  ('contains', 'blowjob'),
  ('contains', 'blowyourload'),
  ('contains', 'bluewaffle'),
  ('contains', 'blumpkin'),
  ('contains', 'bollocks'),
  ('contains', 'bondage'),
  ('contains', 'boner'),
  ('contains', 'boobs'),
  ('contains', 'bootycall'),
  ('contains', 'brownshowers'),
  ('contains', 'brunetteaction'),
  ('contains', 'bukkake'),
  ('contains', 'bulldyke'),
  ('contains', 'bulletvibe'),
  ('contains', 'bullshit'),
  ('contains', 'bunghole'),
  ('contains', 'busty'),
  ('contains', 'buttcheeks'),
  ('contains', 'butthole'),
  ('contains', 'cameltoe'),
  ('contains', 'camgirl'),
  ('contains', 'camslut'),
  ('contains', 'camwhore'),
  ('contains', 'carpetmuncher'),
  ('contains', 'cashapp'),
  ('contains', 'chatgpt'),
  ('contains', 'chink'),
  ('contains', 'chocolaterosebuds'),
  ('contains', 'cialis'),
  ('contains', 'circlejerk'),
  ('contains', 'clevelandsteamer'),
  ('contains', 'clit'),
  ('contains', 'clitoris'),
  ('contains', 'cloutcity'),
  ('contains', 'cloutcityhq'),
  ('contains', 'cloutstaff'),
  ('contains', 'cloutteam'),
  ('contains', 'cloverclamps'),
  ('contains', 'clusterfuck'),
  ('contains', 'cocaine'),
  ('contains', 'cock'),
  ('contains', 'cocks'),
  ('contains', 'coon'),
  ('contains', 'coons'),
  ('contains', 'coprolagnia'),
  ('contains', 'coprophilia'),
  ('contains', 'cornhole'),
  ('contains', 'crackhead'),
  ('contains', 'creampie'),
  ('contains', 'cumming'),
  ('contains', 'cumshot'),
  ('contains', 'cumshots'),
  ('contains', 'cunnilingus'),
  ('contains', 'cunt'),
  ('contains', 'customerservice'),
  ('contains', 'darkie'),
  ('contains', 'daterape'),
  ('contains', 'deepthroat'),
  ('contains', 'dendrophilia'),
  ('contains', 'dick'),
  ('contains', 'dildo'),
  ('contains', 'dingleberries'),
  ('contains', 'dingleberry'),
  ('contains', 'dirtypillows'),
  ('contains', 'dirtysanchez'),
  ('contains', 'doggiestyle'),
  ('contains', 'doggystyle'),
  ('contains', 'dolcett'),
  ('contains', 'dominatrix'),
  ('contains', 'dommes'),
  ('contains', 'donkeypunch'),
  ('contains', 'doubledong'),
  ('contains', 'doublepenetration'),
  ('contains', 'dpaction'),
  ('contains', 'dryhump'),
  ('contains', 'dsny'),
  ('contains', 'dyke'),
  ('contains', 'eatmyass'),
  ('contains', 'ecchi'),
  ('contains', 'ejaculation'),
  ('contains', 'erotic'),
  ('contains', 'erotism'),
  ('contains', 'escort'),
  ('contains', 'eunuch'),
  ('contains', 'facebook'),
  ('contains', 'fag'),
  ('contains', 'faggot'),
  ('contains', 'fbi'),
  ('contains', 'fdny'),
  ('contains', 'fecal'),
  ('contains', 'felch'),
  ('contains', 'fellatio'),
  ('contains', 'feltch'),
  ('contains', 'fema'),
  ('contains', 'femalesquirting'),
  ('contains', 'femdom'),
  ('contains', 'fentanyl'),
  ('contains', 'figging'),
  ('contains', 'fingerbang'),
  ('contains', 'fingering'),
  ('contains', 'fisting'),
  ('contains', 'footfetish'),
  ('contains', 'footjob'),
  ('contains', 'fortnite'),
  ('contains', 'frotting'),
  ('contains', 'fuck'),
  ('contains', 'fuckbuttons'),
  ('contains', 'fuckin'),
  ('contains', 'fucking'),
  ('contains', 'fucktards'),
  ('contains', 'fudgepacker'),
  ('contains', 'futanari'),
  ('contains', 'gamemaster'),
  ('contains', 'gangbang'),
  ('contains', 'gaysex'),
  ('contains', 'genitals'),
  ('contains', 'giantcock'),
  ('contains', 'girlontop'),
  ('contains', 'girlsgonewild'),
  ('contains', 'goatcx'),
  ('contains', 'goatse'),
  ('contains', 'goddamn'),
  ('contains', 'gokkun'),
  ('contains', 'goldenshower'),
  ('contains', 'goodpoop'),
  ('contains', 'googirl'),
  ('contains', 'google'),
  ('contains', 'gook'),
  ('contains', 'goregasm'),
  ('contains', 'governor'),
  ('contains', 'grope'),
  ('contains', 'groupsex'),
  ('contains', 'gspot'),
  ('contains', 'handjob'),
  ('contains', 'helpdesk'),
  ('contains', 'hentai'),
  ('contains', 'heroin'),
  ('contains', 'hitler'),
  ('contains', 'homoerotic'),
  ('contains', 'honkey'),
  ('contains', 'hooker'),
  ('contains', 'horny'),
  ('contains', 'howtokill'),
  ('contains', 'howtomurder'),
  ('contains', 'humping'),
  ('contains', 'incest'),
  ('contains', 'instagram'),
  ('contains', 'intercourse'),
  ('contains', 'jailbait'),
  ('contains', 'jerkoff'),
  ('contains', 'jigaboo'),
  ('contains', 'jiggaboo'),
  ('contains', 'jiggerboo'),
  ('contains', 'jihad'),
  ('contains', 'jizz'),
  ('contains', 'juggs'),
  ('contains', 'ketamine'),
  ('contains', 'kike'),
  ('contains', 'kinbaku'),
  ('contains', 'kinkster'),
  ('contains', 'kinky'),
  ('contains', 'kkk'),
  ('contains', 'knobbing'),
  ('contains', 'leatherrestraint'),
  ('contains', 'leatherstraightjacket'),
  ('contains', 'lemonparty'),
  ('contains', 'livesex'),
  ('contains', 'lolita'),
  ('contains', 'lovemaking'),
  ('contains', 'makemecome'),
  ('contains', 'malesquirting'),
  ('contains', 'masturbate'),
  ('contains', 'masturbating'),
  ('contains', 'masturbation'),
  ('contains', 'mayor'),
  ('contains', 'mdma'),
  ('contains', 'menageatrois'),
  ('contains', 'methhead'),
  ('contains', 'missionaryposition'),
  ('contains', 'moderator'),
  ('contains', 'modteam'),
  ('contains', 'motherfucker'),
  ('contains', 'moundofvenus'),
  ('contains', 'muffdiver'),
  ('contains', 'muffdiving'),
  ('contains', 'nambla'),
  ('contains', 'nawashi'),
  ('contains', 'nazi'),
  ('contains', 'negro'),
  ('contains', 'neonazi'),
  ('contains', 'netflix'),
  ('contains', 'nigga'),
  ('contains', 'nigger'),
  ('contains', 'nignog'),
  ('contains', 'nimphomania'),
  ('contains', 'nintendo'),
  ('contains', 'nipple'),
  ('contains', 'nipples'),
  ('contains', 'nsfw'),
  ('contains', 'nsfwimages'),
  ('contains', 'nudity'),
  ('contains', 'nutten'),
  ('contains', 'nycdot'),
  ('contains', 'nycgov'),
  ('contains', 'nycha'),
  ('contains', 'nycmta'),
  ('contains', 'nympho'),
  ('contains', 'nymphomania'),
  ('contains', 'nypd'),
  ('contains', 'octopussy'),
  ('contains', 'official'),
  ('contains', 'omorashi'),
  ('contains', 'onecuptwogirls'),
  ('contains', 'oneguyonejar'),
  ('contains', 'openai'),
  ('contains', 'orgasm'),
  ('contains', 'oxycontin'),
  ('contains', 'paedophile'),
  ('contains', 'panties'),
  ('contains', 'panty'),
  ('contains', 'paypal'),
  ('contains', 'pedobear'),
  ('contains', 'pedophile'),
  ('contains', 'pegging'),
  ('contains', 'penis'),
  ('contains', 'percocet'),
  ('contains', 'phonesex'),
  ('contains', 'pieceofshit'),
  ('contains', 'pikey'),
  ('contains', 'pissing'),
  ('contains', 'pisspig'),
  ('contains', 'playboy'),
  ('contains', 'playstation'),
  ('contains', 'pleasurechest'),
  ('contains', 'polesmoker'),
  ('contains', 'police'),
  ('contains', 'ponyplay'),
  ('contains', 'poontang'),
  ('contains', 'poopchute'),
  ('contains', 'porn'),
  ('contains', 'porno'),
  ('contains', 'pornography'),
  ('contains', 'princealbertpiercing'),
  ('contains', 'pthc'),
  ('contains', 'pubes'),
  ('contains', 'punany'),
  ('contains', 'pussy'),
  ('contains', 'queaf'),
  ('contains', 'queef'),
  ('contains', 'raghead'),
  ('contains', 'ragingboner'),
  ('contains', 'rape'),
  ('contains', 'raping'),
  ('contains', 'rapist'),
  ('contains', 'rectum'),
  ('contains', 'retard'),
  ('contains', 'reversecowgirl'),
  ('contains', 'rimjob'),
  ('contains', 'rimming'),
  ('contains', 'roblox'),
  ('contains', 'rosypalmandherssisters'),
  ('contains', 'rustytrombone'),
  ('contains', 'sadism'),
  ('contains', 'safetyteam'),
  ('contains', 'santorum'),
  ('contains', 'schlong'),
  ('contains', 'scissoring'),
  ('contains', 'semen'),
  ('contains', 'senator'),
  ('contains', 'sex'),
  ('contains', 'sexcam'),
  ('contains', 'sexual'),
  ('contains', 'sexuality'),
  ('contains', 'sexually'),
  ('contains', 'shavedbeaver'),
  ('contains', 'shavedpussy'),
  ('contains', 'shemale'),
  ('contains', 'sheriff'),
  ('contains', 'shibari'),
  ('contains', 'shit'),
  ('contains', 'shitblimp'),
  ('contains', 'shitty'),
  ('contains', 'shrimping'),
  ('contains', 'skeet'),
  ('contains', 'slanteye'),
  ('contains', 'slut'),
  ('contains', 'snapchat'),
  ('contains', 'snatch'),
  ('contains', 'sodomize'),
  ('contains', 'sodomy'),
  ('contains', 'spastic'),
  ('contains', 'spic'),
  ('contains', 'splooge'),
  ('contains', 'sploogemoose'),
  ('contains', 'spooge'),
  ('contains', 'spotify'),
  ('contains', 'spreadlegs'),
  ('contains', 'spunk'),
  ('contains', 'staff'),
  ('contains', 'strapon'),
  ('contains', 'strappado'),
  ('contains', 'stripclub'),
  ('contains', 'styledoggy'),
  ('contains', 'sucks'),
  ('contains', 'suicidegirls'),
  ('contains', 'sultrywomen'),
  ('contains', 'supabase'),
  ('contains', 'superuser'),
  ('contains', 'support'),
  ('contains', 'swastika'),
  ('contains', 'sysadmin'),
  ('contains', 'teabagging'),
  ('contains', 'teamclout'),
  ('contains', 'terrorist'),
  ('contains', 'threesome'),
  ('contains', 'throating'),
  ('contains', 'thumbzilla'),
  ('contains', 'tiktok'),
  ('contains', 'titties'),
  ('contains', 'titty'),
  ('contains', 'tongueina'),
  ('contains', 'topless'),
  ('contains', 'tosser'),
  ('contains', 'towelhead'),
  ('contains', 'tranny'),
  ('contains', 'tribadism'),
  ('contains', 'trustandsafety'),
  ('contains', 'tubgirl'),
  ('contains', 'tushy'),
  ('contains', 'twat'),
  ('contains', 'twink'),
  ('contains', 'twinkie'),
  ('contains', 'twitch'),
  ('contains', 'twitter'),
  ('contains', 'twogirlsonecup'),
  ('contains', 'undressing'),
  ('contains', 'upskirt'),
  ('contains', 'urethraplay'),
  ('contains', 'urophilia'),
  ('contains', 'usps'),
  ('contains', 'vagina'),
  ('contains', 'venmo'),
  ('contains', 'venusmound'),
  ('contains', 'vercel'),
  ('contains', 'viagra'),
  ('contains', 'vibrator'),
  ('contains', 'vorarephilia'),
  ('contains', 'voyeur'),
  ('contains', 'voyeurweb'),
  ('contains', 'voyuer'),
  ('contains', 'vulva'),
  ('contains', 'wanker'),
  ('contains', 'webmaster'),
  ('contains', 'wetback'),
  ('contains', 'wetdream'),
  ('contains', 'whatsapp'),
  ('contains', 'whitehouse'),
  ('contains', 'whitepower'),
  ('contains', 'whore'),
  ('contains', 'worldsex'),
  ('contains', 'wrinkledstarfish'),
  ('contains', 'xanax'),
  ('contains', 'xbox'),
  ('contains', 'xxx'),
  ('contains', 'yellowshowers'),
  ('contains', 'yiffy'),
  ('contains', 'youtube'),
  ('contains', 'zoophilia'),
  ('exact', '2gic'),
  ('exact', 'about'),
  ('exact', 'aboutus'),
  ('exact', 'abuse'),
  ('exact', 'access'),
  ('exact', 'account'),
  ('exact', 'accounts'),
  ('exact', 'ad'),
  ('exact', 'add'),
  ('exact', 'admin'),
  ('exact', 'administration'),
  ('exact', 'administrator'),
  ('exact', 'ads'),
  ('exact', 'adstxt'),
  ('exact', 'advertise'),
  ('exact', 'advertising'),
  ('exact', 'aes2s6ctr'),
  ('exact', 'aes2s6gcm'),
  ('exact', 'aesi2bctr'),
  ('exact', 'aesi2bgcm'),
  ('exact', 'aesig2ctr'),
  ('exact', 'affiliate'),
  ('exact', 'affiliates'),
  ('exact', 'ajax'),
  ('exact', 'alert'),
  ('exact', 'alerts'),
  ('exact', 'alpha'),
  ('exact', 'amazon'),
  ('exact', 'amp'),
  ('exact', 'anal'),
  ('exact', 'analytics'),
  ('exact', 'anonymous'),
  ('exact', 'anus'),
  ('exact', 'api'),
  ('exact', 'app'),
  ('exact', 'appadstxt'),
  ('exact', 'apple'),
  ('exact', 'apps'),
  ('exact', 'asc'),
  ('exact', 'ass'),
  ('exact', 'assets'),
  ('exact', 'atom'),
  ('exact', 'auth'),
  ('exact', 'authentication'),
  ('exact', 'authorize'),
  ('exact', 'autoconfig'),
  ('exact', 'autodiscover'),
  ('exact', 'avatar'),
  ('exact', 'backup'),
  ('exact', 'banner'),
  ('exact', 'banners'),
  ('exact', 'barenaked'),
  ('exact', 'bbs'),
  ('exact', 'bbw'),
  ('exact', 'beta'),
  ('exact', 'bigblack'),
  ('exact', 'billing'),
  ('exact', 'billings'),
  ('exact', 'blog'),
  ('exact', 'blogs'),
  ('exact', 'board'),
  ('exact', 'boob'),
  ('exact', 'bookmark'),
  ('exact', 'bookmarks'),
  ('exact', 'bot'),
  ('exact', 'broadcasthost'),
  ('exact', 'business'),
  ('exact', 'butt'),
  ('exact', 'buy'),
  ('exact', 'cache'),
  ('exact', 'calendar'),
  ('exact', 'campaign'),
  ('exact', 'captcha'),
  ('exact', 'careers'),
  ('exact', 'cart'),
  ('exact', 'cas'),
  ('exact', 'categories'),
  ('exact', 'category'),
  ('exact', 'cdn'),
  ('exact', 'ceo'),
  ('exact', 'cgi'),
  ('exact', 'cgibin'),
  ('exact', 'chacha2opolyieos'),
  ('exact', 'change'),
  ('exact', 'channel'),
  ('exact', 'channels'),
  ('exact', 'chart'),
  ('exact', 'chat'),
  ('exact', 'checkout'),
  ('exact', 'cia'),
  ('exact', 'cityhall'),
  ('exact', 'clear'),
  ('exact', 'client'),
  ('exact', 'close'),
  ('exact', 'cloud'),
  ('exact', 'clout'),
  ('exact', 'cms'),
  ('exact', 'com'),
  ('exact', 'comment'),
  ('exact', 'comments'),
  ('exact', 'community'),
  ('exact', 'compare'),
  ('exact', 'compose'),
  ('exact', 'config'),
  ('exact', 'connect'),
  ('exact', 'contact'),
  ('exact', 'contest'),
  ('exact', 'cookies'),
  ('exact', 'copy'),
  ('exact', 'copyright'),
  ('exact', 'count'),
  ('exact', 'cp'),
  ('exact', 'cpanel'),
  ('exact', 'create'),
  ('exact', 'crossdomainxml'),
  ('exact', 'css'),
  ('exact', 'cum'),
  ('exact', 'curve2ssigsha2s6'),
  ('exact', 'customer'),
  ('exact', 'customers'),
  ('exact', 'customize'),
  ('exact', 'dashboard'),
  ('exact', 'db'),
  ('exact', 'deals'),
  ('exact', 'debug'),
  ('exact', 'delete'),
  ('exact', 'desc'),
  ('exact', 'destroy'),
  ('exact', 'dev'),
  ('exact', 'developer'),
  ('exact', 'developers'),
  ('exact', 'devs'),
  ('exact', 'dhs'),
  ('exact', 'diffiehellmangroupexchangesha2s6'),
  ('exact', 'diffiehellmangroupiashai'),
  ('exact', 'disconnect'),
  ('exact', 'discord'),
  ('exact', 'discuss'),
  ('exact', 'dmv'),
  ('exact', 'dns'),
  ('exact', 'dns2'),
  ('exact', 'dnsa'),
  ('exact', 'dnse'),
  ('exact', 'dnsi'),
  ('exact', 'dnso'),
  ('exact', 'docs'),
  ('exact', 'documentation'),
  ('exact', 'dogstyle'),
  ('exact', 'domain'),
  ('exact', 'domainkey'),
  ('exact', 'domination'),
  ('exact', 'download'),
  ('exact', 'downloads'),
  ('exact', 'downvote'),
  ('exact', 'draft'),
  ('exact', 'drop'),
  ('exact', 'dvda'),
  ('exact', 'ecdhsha2nistp2s6'),
  ('exact', 'ecdhsha2nistpeba'),
  ('exact', 'ecdhsha2nistps2i'),
  ('exact', 'edit'),
  ('exact', 'editor'),
  ('exact', 'email'),
  ('exact', 'employee'),
  ('exact', 'enterprise'),
  ('exact', 'error'),
  ('exact', 'errors'),
  ('exact', 'event'),
  ('exact', 'events'),
  ('exact', 'everyone'),
  ('exact', 'example'),
  ('exact', 'exception'),
  ('exact', 'exit'),
  ('exact', 'explore'),
  ('exact', 'export'),
  ('exact', 'extensions'),
  ('exact', 'false'),
  ('exact', 'family'),
  ('exact', 'famous'),
  ('exact', 'faq'),
  ('exact', 'faqs'),
  ('exact', 'faviconico'),
  ('exact', 'features'),
  ('exact', 'feed'),
  ('exact', 'feedback'),
  ('exact', 'feeds'),
  ('exact', 'file'),
  ('exact', 'files'),
  ('exact', 'filter'),
  ('exact', 'follow'),
  ('exact', 'follower'),
  ('exact', 'followers'),
  ('exact', 'following'),
  ('exact', 'fonts'),
  ('exact', 'forgot'),
  ('exact', 'forgotpassword'),
  ('exact', 'form'),
  ('exact', 'forms'),
  ('exact', 'forum'),
  ('exact', 'forums'),
  ('exact', 'friend'),
  ('exact', 'friends'),
  ('exact', 'ftp'),
  ('exact', 'get'),
  ('exact', 'girlon'),
  ('exact', 'git'),
  ('exact', 'go'),
  ('exact', 'graphql'),
  ('exact', 'group'),
  ('exact', 'groups'),
  ('exact', 'guest'),
  ('exact', 'guidelines'),
  ('exact', 'guides'),
  ('exact', 'guro'),
  ('exact', 'hardcore'),
  ('exact', 'head'),
  ('exact', 'header'),
  ('exact', 'help'),
  ('exact', 'hide'),
  ('exact', 'hmacsha'),
  ('exact', 'hmacsha22s6'),
  ('exact', 'hmacsha22s6etm'),
  ('exact', 'hmacsha2si2'),
  ('exact', 'hmacsha2si2etm'),
  ('exact', 'hmacshai'),
  ('exact', 'hmacshaietm'),
  ('exact', 'home'),
  ('exact', 'homo'),
  ('exact', 'host'),
  ('exact', 'hosting'),
  ('exact', 'hostmaster'),
  ('exact', 'hotcarl'),
  ('exact', 'hotchick'),
  ('exact', 'htaccess'),
  ('exact', 'htpasswd'),
  ('exact', 'http'),
  ('exact', 'httpd'),
  ('exact', 'https'),
  ('exact', 'hugefat'),
  ('exact', 'humanstxt'),
  ('exact', 'ice'),
  ('exact', 'icon'),
  ('exact', 'icons'),
  ('exact', 'images'),
  ('exact', 'imap'),
  ('exact', 'img'),
  ('exact', 'import'),
  ('exact', 'index'),
  ('exact', 'info'),
  ('exact', 'insert'),
  ('exact', 'investors'),
  ('exact', 'invitations'),
  ('exact', 'invite'),
  ('exact', 'invites'),
  ('exact', 'invoice'),
  ('exact', 'irs'),
  ('exact', 'is'),
  ('exact', 'isatap'),
  ('exact', 'isis'),
  ('exact', 'issues'),
  ('exact', 'it'),
  ('exact', 'jackoff'),
  ('exact', 'jap'),
  ('exact', 'jellydonut'),
  ('exact', 'jobs'),
  ('exact', 'join'),
  ('exact', 'js'),
  ('exact', 'json'),
  ('exact', 'keybasetxt'),
  ('exact', 'known'),
  ('exact', 'kraut'),
  ('exact', 'learn'),
  ('exact', 'legal'),
  ('exact', 'license'),
  ('exact', 'licensing'),
  ('exact', 'like'),
  ('exact', 'limit'),
  ('exact', 'live'),
  ('exact', 'load'),
  ('exact', 'local'),
  ('exact', 'localdomain'),
  ('exact', 'localhost'),
  ('exact', 'lock'),
  ('exact', 'login'),
  ('exact', 'logout'),
  ('exact', 'lostpassword'),
  ('exact', 'lsd'),
  ('exact', 'mail'),
  ('exact', 'mail2'),
  ('exact', 'mail6'),
  ('exact', 'maila'),
  ('exact', 'mailb'),
  ('exact', 'maile'),
  ('exact', 'mailerdaemon'),
  ('exact', 'mailg'),
  ('exact', 'maili'),
  ('exact', 'mailo'),
  ('exact', 'mails'),
  ('exact', 'mailt'),
  ('exact', 'map'),
  ('exact', 'marketing'),
  ('exact', 'marketplace'),
  ('exact', 'master'),
  ('exact', 'me'),
  ('exact', 'media'),
  ('exact', 'member'),
  ('exact', 'members'),
  ('exact', 'message'),
  ('exact', 'messages'),
  ('exact', 'meta'),
  ('exact', 'metrics'),
  ('exact', 'milf'),
  ('exact', 'mis'),
  ('exact', 'mobile'),
  ('exact', 'mod'),
  ('exact', 'moderator'),
  ('exact', 'modify'),
  ('exact', 'mods'),
  ('exact', 'mong'),
  ('exact', 'more'),
  ('exact', 'mrhands'),
  ('exact', 'mta'),
  ('exact', 'mx'),
  ('exact', 'mxi'),
  ('exact', 'my'),
  ('exact', 'net'),
  ('exact', 'network'),
  ('exact', 'new'),
  ('exact', 'news'),
  ('exact', 'newsletter'),
  ('exact', 'newsletters'),
  ('exact', 'next'),
  ('exact', 'nil'),
  ('exact', 'nobody'),
  ('exact', 'noc'),
  ('exact', 'none'),
  ('exact', 'noreply'),
  ('exact', 'notification'),
  ('exact', 'notifications'),
  ('exact', 'ns'),
  ('exact', 'ns2'),
  ('exact', 'ns6'),
  ('exact', 'nsa'),
  ('exact', 'nsb'),
  ('exact', 'nse'),
  ('exact', 'nsg'),
  ('exact', 'nsi'),
  ('exact', 'nso'),
  ('exact', 'nss'),
  ('exact', 'nst'),
  ('exact', 'nude'),
  ('exact', 'null'),
  ('exact', 'nyc'),
  ('exact', 'oauth'),
  ('exact', 'oauth2'),
  ('exact', 'offer'),
  ('exact', 'offers'),
  ('exact', 'online'),
  ('exact', 'openid'),
  ('exact', 'operator'),
  ('exact', 'order'),
  ('exact', 'orders'),
  ('exact', 'orgy'),
  ('exact', 'overview'),
  ('exact', 'owa'),
  ('exact', 'owner'),
  ('exact', 'page'),
  ('exact', 'pages'),
  ('exact', 'paki'),
  ('exact', 'partners'),
  ('exact', 'passwd'),
  ('exact', 'password'),
  ('exact', 'pay'),
  ('exact', 'payment'),
  ('exact', 'payments'),
  ('exact', 'paypal'),
  ('exact', 'photo'),
  ('exact', 'photos'),
  ('exact', 'pixel'),
  ('exact', 'plans'),
  ('exact', 'player'),
  ('exact', 'plugins'),
  ('exact', 'policies'),
  ('exact', 'policy'),
  ('exact', 'poof'),
  ('exact', 'poon'),
  ('exact', 'pop'),
  ('exact', 'pope'),
  ('exact', 'popular'),
  ('exact', 'portal'),
  ('exact', 'portfolio'),
  ('exact', 'post'),
  ('exact', 'postfix'),
  ('exact', 'postmaster'),
  ('exact', 'poweruser'),
  ('exact', 'preferences'),
  ('exact', 'premium'),
  ('exact', 'press'),
  ('exact', 'previous'),
  ('exact', 'pricing'),
  ('exact', 'print'),
  ('exact', 'privacy'),
  ('exact', 'privacypolicy'),
  ('exact', 'private'),
  ('exact', 'prod'),
  ('exact', 'product'),
  ('exact', 'production'),
  ('exact', 'profile'),
  ('exact', 'profiles'),
  ('exact', 'project'),
  ('exact', 'projects'),
  ('exact', 'promo'),
  ('exact', 'public'),
  ('exact', 'purchase'),
  ('exact', 'put'),
  ('exact', 'quim'),
  ('exact', 'quota'),
  ('exact', 'redirect'),
  ('exact', 'reduce'),
  ('exact', 'refund'),
  ('exact', 'refunds'),
  ('exact', 'register'),
  ('exact', 'registration'),
  ('exact', 'remove'),
  ('exact', 'replies'),
  ('exact', 'reply'),
  ('exact', 'report'),
  ('exact', 'request'),
  ('exact', 'requestpassword'),
  ('exact', 'reset'),
  ('exact', 'resetpassword'),
  ('exact', 'response'),
  ('exact', 'return'),
  ('exact', 'returns'),
  ('exact', 'review'),
  ('exact', 'reviews'),
  ('exact', 'robotstxt'),
  ('exact', 'root'),
  ('exact', 'rootuser'),
  ('exact', 'rosypalm'),
  ('exact', 'rsasha22'),
  ('exact', 'rsasha2si2'),
  ('exact', 'rss'),
  ('exact', 'rules'),
  ('exact', 'safety'),
  ('exact', 'sales'),
  ('exact', 'save'),
  ('exact', 'scat'),
  ('exact', 'sceneregular'),
  ('exact', 'script'),
  ('exact', 'sdk'),
  ('exact', 'search'),
  ('exact', 'secure'),
  ('exact', 'security'),
  ('exact', 'select'),
  ('exact', 'server'),
  ('exact', 'services'),
  ('exact', 'session'),
  ('exact', 'sessions'),
  ('exact', 'settings'),
  ('exact', 'setup'),
  ('exact', 'sexo'),
  ('exact', 'sexy'),
  ('exact', 'share'),
  ('exact', 'shift'),
  ('exact', 'shop'),
  ('exact', 'shota'),
  ('exact', 'signin'),
  ('exact', 'signup'),
  ('exact', 'site'),
  ('exact', 'sitemap'),
  ('exact', 'sites'),
  ('exact', 'sm'),
  ('exact', 'smtp'),
  ('exact', 'smut'),
  ('exact', 'snowballing'),
  ('exact', 'sort'),
  ('exact', 'source'),
  ('exact', 'sql'),
  ('exact', 'ssh'),
  ('exact', 'sshrsa'),
  ('exact', 'ssl'),
  ('exact', 'ssladmin'),
  ('exact', 'ssladministrator'),
  ('exact', 'sslwebmaster'),
  ('exact', 'stage'),
  ('exact', 'staging'),
  ('exact', 'stat'),
  ('exact', 'static'),
  ('exact', 'statistics'),
  ('exact', 'stats'),
  ('exact', 'status'),
  ('exact', 'stoner'),
  ('exact', 'store'),
  ('exact', 'stripe'),
  ('exact', 'style'),
  ('exact', 'styles'),
  ('exact', 'stylesheet'),
  ('exact', 'stylesheets'),
  ('exact', 'subdomain'),
  ('exact', 'subscribe'),
  ('exact', 'suck'),
  ('exact', 'sudo'),
  ('exact', 'super'),
  ('exact', 'superuser'),
  ('exact', 'support'),
  ('exact', 'survey'),
  ('exact', 'swinger'),
  ('exact', 'sync'),
  ('exact', 'sysadmin'),
  ('exact', 'system'),
  ('exact', 'tablet'),
  ('exact', 'tag'),
  ('exact', 'tags'),
  ('exact', 'taintedlove'),
  ('exact', 'tastemy'),
  ('exact', 'team'),
  ('exact', 'telnet'),
  ('exact', 'terms'),
  ('exact', 'termsofuse'),
  ('exact', 'test'),
  ('exact', 'testimonials'),
  ('exact', 'theme'),
  ('exact', 'themes'),
  ('exact', 'tiedup'),
  ('exact', 'tightwhite'),
  ('exact', 'tit'),
  ('exact', 'tits'),
  ('exact', 'today'),
  ('exact', 'tools'),
  ('exact', 'topic'),
  ('exact', 'topics'),
  ('exact', 'tour'),
  ('exact', 'training'),
  ('exact', 'translate'),
  ('exact', 'translations'),
  ('exact', 'trending'),
  ('exact', 'trial'),
  ('exact', 'true'),
  ('exact', 'umac6a'),
  ('exact', 'umac6aetm'),
  ('exact', 'umaci2b'),
  ('exact', 'umaci2betm'),
  ('exact', 'undefined'),
  ('exact', 'unfollow'),
  ('exact', 'unlike'),
  ('exact', 'unsubscribe'),
  ('exact', 'update'),
  ('exact', 'upgrade'),
  ('exact', 'usenet'),
  ('exact', 'user'),
  ('exact', 'username'),
  ('exact', 'users'),
  ('exact', 'uucp'),
  ('exact', 'var'),
  ('exact', 'verify'),
  ('exact', 'video'),
  ('exact', 'view'),
  ('exact', 'violetwand'),
  ('exact', 'void'),
  ('exact', 'vote'),
  ('exact', 'vpn'),
  ('exact', 'wank'),
  ('exact', 'webmail'),
  ('exact', 'webmaster'),
  ('exact', 'website'),
  ('exact', 'wellknown'),
  ('exact', 'widget'),
  ('exact', 'widgets'),
  ('exact', 'wiki'),
  ('exact', 'wop'),
  ('exact', 'wpad'),
  ('exact', 'wrappingmen'),
  ('exact', 'write'),
  ('exact', 'www'),
  ('exact', 'www2'),
  ('exact', 'wwwa'),
  ('exact', 'wwwdata'),
  ('exact', 'wwwe'),
  ('exact', 'wwwi'),
  ('exact', 'xx'),
  ('exact', 'yaoi'),
  ('exact', 'you'),
  ('exact', 'yourname'),
  ('exact', 'yourusername'),
  ('exact', 'zelle'),
  ('exact', 'zlib');
-- END GENERATED handle seed

-- Players who attested before this migration get their generated handle now.
do $$
begin
  perform private.ensure_handle(p.id) from public.profiles p where p.attested and p.handle is null;
end;
$$;
