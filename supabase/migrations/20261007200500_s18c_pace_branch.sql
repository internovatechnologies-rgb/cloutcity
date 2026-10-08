-- S18c fix cycle 1 (bug-hunter H1, H2 and lows).
--
-- H1 (DEC-19): the honest-pace credit. Save plausibility bounds what play brought in since the
-- last accept by the counted taps at the economy bots' pace plus a small per-player credit, a
-- token bucket the server carries between uploads like the burst credit. commit_save stores it;
-- clients never see it (the saves column grants list only the readable columns).
--
-- H2: "keep this device" checks the kept save against the save both devices last shared, which
-- POST /api/save reads from private.save_history through the service-only save_at_revision.
--
-- Low: set_audio_settings is rate limited.

alter table public.saves
  add column pace_credit_cash double precision not null default 0 check (pace_credit_cash >= 0),
  add column pace_credit_clout double precision not null default 0 check (pace_credit_clout >= 0);

drop function public.commit_save(
  uuid, bigint, integer, jsonb, uuid, timestamptz, text, text, boolean, jsonb, jsonb,
  double precision, integer, integer, integer
);

-- As in the S18c migration, plus the honest-pace credit (p_pace_credit_cash/clout).
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
  p_pace_credit_cash double precision,
  p_pace_credit_clout double precision,
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
    or p_pace_credit_cash is null or p_pace_credit_cash < 0
    or p_pace_credit_clout is null or p_pace_credit_clout < 0
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
      burst_credit_minutes = p_burst_credit_minutes,
      pace_credit_cash = p_pace_credit_cash,
      pace_credit_clout = p_pace_credit_clout
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
  double precision, double precision, double precision, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.commit_save(
  uuid, bigint, integer, jsonb, uuid, timestamptz, text, text, boolean, jsonb, jsonb,
  double precision, double precision, double precision, integer, integer, integer
) to service_role;

-- A save this player's history still keeps (the last sync.json historyKeep accepted saves), or
-- no row once it has been trimmed.
create function public.save_at_revision(p_user_id uuid, p_revision bigint)
returns table (revision bigint, save_version integer, data jsonb, accepted_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select h.revision, h.save_version, h.data, h.accepted_at
  from private.save_history h
  where h.user_id = p_user_id and h.revision = p_revision
  order by h.id desc
  limit 1;
$$;

revoke execute on function public.save_at_revision(uuid, bigint) from public, anon, authenticated;
grant execute on function public.save_at_revision(uuid, bigint) to service_role;

create or replace function public.set_audio_settings(p_volumes jsonb, p_updated_at timestamptz)
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
  -- A volume slider fires often; the device sends after a quiet time, so this is generous.
  perform private.consume_rate_limit(v_uid, 'audio_settings', 30, interval '1 minute');
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
