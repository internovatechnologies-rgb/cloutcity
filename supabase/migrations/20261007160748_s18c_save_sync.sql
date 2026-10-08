-- S18c cloud save sync and the public projection.
--
-- The device uploads its save to the Next.js route POST /api/save (src/app/api/save/route.ts),
-- which checks it against the last accepted save (src/engine/plausibility.ts) and then calls one
-- of two service-role-only functions here:
--
--  - commit_save: stores an accepted (or repaired) save with a compare-and-swap on its revision,
--    rate-limits uploads, keeps the last accepted saves in private.save_history, inserts the new
--    grant records (SEC-8), and writes the public projection (INT-10): the profile's
--    public_level, career_path and avatar. Nothing else writes those three columns.
--  - quarantine_save: keeps a rejected upload in private.save_quarantine and flags the save.
--
-- Clients read their own save row, but not the columns the server keeps for itself (flags, the
-- rate window, the burst credit). Their only write here is set_audio_settings, a private sound
-- preference (attestation- and standing-exempt).
--
-- Error messages are machine codes with SQLSTATE PTxyz → HTTP xyz (src/lib/supabase/attestation.ts).

-- SEC-8: the grant key is the engine's own (`goal:<id>:r<run>`), unique per player, and the
-- clout cap has its own column. Rows from before used `<user id>:<key>`: the prefix is dropped
-- (the append-only trigger is paused for that one rewrite), and their clout cap, kept only in
-- eligibility until now, becomes the amount they applied (which the cap always covered).
alter table public.grants
  add column clout_cap integer,
  drop constraint grants_idempotency_key_key;

alter table public.grants disable trigger grants_append_only;
update public.grants g
set idempotency_key = substr(g.idempotency_key, length(g.user_id::text) + 2)
where g.idempotency_key like g.user_id::text || ':%'
  and not exists (
    select 1 from public.grants o
    where o.user_id = g.user_id
      and o.idempotency_key = substr(g.idempotency_key, length(g.user_id::text) + 2)
  );
update public.grants g set clout_cap = g.clout_amount where g.clout_cap is null;
alter table public.grants enable trigger grants_append_only;

alter table public.grants
  alter column clout_cap set not null,
  add constraint grants_clout_cap_nonnegative check (clout_cap >= 0),
  add constraint grants_clout_within_cap check (clout_amount <= clout_cap),
  add constraint grants_user_idempotency_key unique (user_id, idempotency_key);

-- DEC-20: the four career paths (kebab-case ids, src/lib/data IdSchema). Until S16a adds the
-- player's chosen path to the save, commit_save writes null.
alter table public.profiles
  add constraint profiles_career_path_known check (
    career_path is null or career_path in ('influencer', 'streamer', 'artist-dj', 'founder-hustler')
  );

-- The player's volumes (src/state/audioSettings.ts), synced across devices: the newer wins.
alter table public.profiles
  add column audio_settings jsonb,
  add column audio_settings_updated_at timestamptz,
  add constraint profiles_audio_settings_shape check (
    audio_settings is null
    or (jsonb_typeof(audio_settings) = 'object' and octet_length(audio_settings::text) <= 512)
  ),
  add constraint profiles_audio_settings_pair check (
    (audio_settings is null) = (audio_settings_updated_at is null)
  );

-- What the server keeps on the save row: when it accepted the save and from which device, the
-- per-minute upload window, and the plausibility burst credit (DEC-19, a token bucket in real
-- minutes carried from one upload to the next).
alter table public.saves
  add column accepted_at timestamptz,
  add column last_device_id uuid,
  add column rate_window_started_at timestamptz,
  add column rate_window_count integer not null default 0 check (rate_window_count >= 0),
  add column burst_credit_minutes double precision not null default 0
    check (burst_credit_minutes >= 0);

-- The owner reads their save, never the flags, the rate window or the burst credit.
revoke select on table public.saves from authenticated;
grant select (
  user_id, save_version, revision, data, client_saved_at, accepted_at, last_device_id,
  created_at, updated_at
) on table public.saves to authenticated;

-- The last accepted saves per player (sync.json historyKeep), for support and rollback.
create table private.save_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  revision bigint not null check (revision > 0),
  save_version integer not null check (save_version > 0),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  device_id uuid,
  accepted_at timestamptz not null default now()
);

create index save_history_user_id_idx on private.save_history (user_id, id desc);

-- The last rejected uploads per player (sync.json quarantineKeep), with what was wrong.
create table private.save_quarantine (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  base_revision bigint not null check (base_revision >= 0),
  save_version integer not null check (save_version > 0),
  data jsonb not null
    check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 262144),
  findings text[] not null check (cardinality(findings) > 0),
  device_id uuid,
  received_at timestamptz not null default now()
);

create index save_quarantine_user_id_idx on private.save_quarantine (user_id, id desc);

alter table private.save_history enable row level security;
alter table private.save_quarantine enable row level security;
revoke all on table private.save_history, private.save_quarantine
  from public, anon, authenticated, service_role;

-- The attestation gate for server code acting for a player (the service role has no auth.uid()).
create function private.require_attested(p_uid uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_uid is null or not exists (
    select 1 from public.profiles p where p.id = p_uid and p.attested
  ) then
    raise exception 'attestation_required' using errcode = 'PT403';
  end if;
end;
$$;

revoke execute on function private.require_attested(uuid) from public, anon, authenticated;

-- Stores an accepted save (see the file comment). `p_expected_revision` is the revision the
-- device's upload was based on (0 for a player with no save yet): anything else is a conflict
-- (409). Uploads are limited to one per `p_min_interval_ms` and `p_max_per_minute` a minute
-- (429). `p_grants` holds src/engine/grants.ts `toServerGrantRow` rows; one the server already
-- holds is left as it is. The projection keeps the stored career path when `p_career_path` is
-- null within the same run (DEC-19).
create function public.commit_save(
  p_user_id uuid,
  p_expected_revision bigint,
  p_save_version integer,
  p_data jsonb,
  p_device_id uuid,
  p_client_saved_at timestamptz,
  p_public_level text,
  p_career_path text,
  p_same_run boolean,
  p_avatar jsonb,
  p_grants jsonb,
  p_burst_credit_minutes double precision,
  p_min_interval_ms integer,
  p_max_per_minute integer,
  p_history_keep integer
)
returns table (saved_revision bigint, saved_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.saves;
  v_now timestamptz := now();
  v_window timestamptz;
  v_count integer;
  v_revision bigint;
begin
  perform private.require_attested(p_user_id);
  if p_expected_revision is null or p_expected_revision < 0
    or p_save_version is null or p_save_version < 1
    or p_data is null or jsonb_typeof(p_data) <> 'object'
    or p_device_id is null or p_same_run is null or p_public_level is null
    or p_avatar is null or jsonb_typeof(p_avatar) <> 'object'
    or p_grants is null or jsonb_typeof(p_grants) <> 'array'
    or p_burst_credit_minutes is null or p_burst_credit_minutes < 0
    or p_min_interval_ms is null or p_min_interval_ms < 0
    or p_max_per_minute is null or p_max_per_minute < 1
    or p_history_keep is null or p_history_keep < 1 then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;

  select * into v_row from public.saves s where s.user_id = p_user_id for update;
  if not found then
    if p_expected_revision <> 0 then
      raise exception 'revision_conflict' using errcode = 'PT409';
    end if;
    -- Two first uploads at once: the second finds the row taken and conflicts.
    insert into public.saves (user_id, save_version, revision, data)
    values (p_user_id, p_save_version, 0, p_data)
    on conflict (user_id) do nothing;
    if not found then
      raise exception 'revision_conflict' using errcode = 'PT409';
    end if;
    select * into v_row from public.saves s where s.user_id = p_user_id for update;
  else
    if v_row.revision <> p_expected_revision then
      raise exception 'revision_conflict' using errcode = 'PT409';
    end if;
    if p_save_version < v_row.save_version then
      raise exception 'version_regressed' using errcode = 'PT409';
    end if;
    if v_row.accepted_at is not null
      and v_row.accepted_at > v_now - make_interval(secs => p_min_interval_ms / 1000.0) then
      raise exception 'rate_limited' using errcode = 'PT429';
    end if;
  end if;

  if v_row.rate_window_started_at is null
    or v_row.rate_window_started_at <= v_now - interval '1 minute' then
    v_window := v_now;
    v_count := 1;
  else
    v_window := v_row.rate_window_started_at;
    v_count := v_row.rate_window_count + 1;
  end if;
  if v_count > p_max_per_minute then
    raise exception 'rate_limited' using errcode = 'PT429';
  end if;

  v_revision := v_row.revision + 1;
  update public.saves s
  set save_version = p_save_version,
      revision = v_revision,
      data = p_data,
      client_saved_at = p_client_saved_at,
      accepted_at = v_now,
      last_device_id = p_device_id,
      rate_window_started_at = v_window,
      rate_window_count = v_count,
      burst_credit_minutes = p_burst_credit_minutes
  where s.user_id = p_user_id;

  insert into private.save_history (user_id, revision, save_version, data, device_id, accepted_at)
  values (p_user_id, v_revision, p_save_version, p_data, p_device_id, v_now);
  delete from private.save_history h
  where h.user_id = p_user_id
    and h.id not in (
      select k.id from private.save_history k
      where k.user_id = p_user_id
      order by k.id desc
      limit p_history_keep
    );

  insert into public.grants (
    user_id, kind, idempotency_key, cash_amount, clout_amount, item_id, cap_amount, clout_cap,
    eligibility, reason, issued_by, campaign_id, applied_at
  )
  select p_user_id, g.kind, g.idempotency_key, g.cash_amount, g.clout_amount, g.item_id,
    g.cap_amount, g.clout_cap, g.eligibility, g.reason, 'system', null, v_now
  from jsonb_to_recordset(p_grants) as g(
    kind text, idempotency_key text, cash_amount integer, clout_amount integer, item_id text,
    cap_amount integer, clout_cap integer, eligibility jsonb, reason text
  )
  on conflict (user_id, idempotency_key) do nothing;

  update public.profiles p
  set public_level = p_public_level,
      career_path = case
        when p_career_path is not null then p_career_path
        when p_same_run then p.career_path
        else null
      end,
      avatar = p_avatar
  where p.id = p_user_id;

  return query select v_revision, v_now;
end;
$$;

revoke execute on function public.commit_save(
  uuid, bigint, integer, jsonb, uuid, timestamptz, text, text, boolean, jsonb, jsonb,
  double precision, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.commit_save(
  uuid, bigint, integer, jsonb, uuid, timestamptz, text, text, boolean, jsonb, jsonb,
  double precision, integer, integer, integer
) to service_role;

-- Keeps a rejected upload (see the file comment) and flags the save. Rejected uploads have their
-- own per-minute limit (429), so they cannot flood the quarantine.
create function public.quarantine_save(
  p_user_id uuid,
  p_base_revision bigint,
  p_save_version integer,
  p_data jsonb,
  p_findings text[],
  p_device_id uuid,
  p_max_per_minute integer,
  p_quarantine_keep integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_attested(p_user_id);
  if p_base_revision is null or p_base_revision < 0
    or p_save_version is null or p_save_version < 1
    or p_data is null or jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 262144
    or p_findings is null or cardinality(p_findings) = 0
    or p_max_per_minute is null or p_max_per_minute < 1
    or p_quarantine_keep is null or p_quarantine_keep < 1 then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  perform private.consume_rate_limit(
    p_user_id, 'save_quarantine', p_max_per_minute, interval '1 minute'
  );

  insert into private.save_quarantine (
    user_id, base_revision, save_version, data, findings, device_id
  )
  values (p_user_id, p_base_revision, p_save_version, p_data, p_findings, p_device_id);
  delete from private.save_quarantine q
  where q.user_id = p_user_id
    and q.id not in (
      select k.id from private.save_quarantine k
      where k.user_id = p_user_id
      order by k.id desc
      limit p_quarantine_keep
    );

  update public.saves s
  set flagged_at = now(),
      flag_reason = left(array_to_string(p_findings, ','), 200)
  where s.user_id = p_user_id;
end;
$$;

revoke execute on function public.quarantine_save(
  uuid, bigint, integer, jsonb, text[], uuid, integer, integer
) from public, anon, authenticated;
grant execute on function public.quarantine_save(
  uuid, bigint, integer, jsonb, text[], uuid, integer, integer
) to service_role;

-- The player's volumes across devices: stored when newer than what the server holds; returns
-- what the server holds afterwards, so the device adopts a newer copy from another device.
create function public.set_audio_settings(p_volumes jsonb, p_updated_at timestamptz)
returns table (volumes jsonb, updated_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_earliest constant timestamptz := '2026-01-01T00:00:00Z';
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_volumes is null or jsonb_typeof(p_volumes) <> 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(p_volumes) as k)
      is distinct from array['ambience', 'master', 'music', 'sfx', 'voice']
    or exists (
      select 1 from jsonb_each(p_volumes) as e(key, value)
      where jsonb_typeof(e.value) <> 'number'
        or e.value::numeric <> trunc(e.value::numeric)
        or e.value::numeric < 0 or e.value::numeric > 100
    ) then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  -- Device clocks drift a little; anything further out is not a real change time.
  if p_updated_at is null or p_updated_at < v_earliest
    or p_updated_at > now() + interval '5 minutes' then
    raise exception 'invalid_timestamp' using errcode = 'PT400';
  end if;

  update public.profiles p
  set audio_settings = p_volumes,
      audio_settings_updated_at = p_updated_at
  where p.id = v_uid
    and (p.audio_settings_updated_at is null or p.audio_settings_updated_at < p_updated_at);

  return query
  select p.audio_settings, p.audio_settings_updated_at from public.profiles p where p.id = v_uid;
end;
$$;

revoke execute on function public.set_audio_settings(jsonb, timestamptz) from public, anon;
grant execute on function public.set_audio_settings(jsonb, timestamptz) to authenticated;
comment on function public.set_audio_settings(jsonb, timestamptz) is
  E'@attestation-exempt: a private sound preference, neither social, realtime nor purchase\n@standing-exempt: a private sound preference';
