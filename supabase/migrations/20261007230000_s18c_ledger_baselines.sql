-- S18c fix cycle 6 (R1): baselines on the revision ledger.
--
-- "Keep this device" from a revision whose full save was trimmed is measured from that revision:
-- its tap count, personal-clock minute, run and prestige count, so the window holds only what was
-- played since (not the whole run against the time since). Revisions the history still holds are
-- backfilled; others keep null baselines, and POST /api/save then measures from the account's
-- creation instead.

alter table private.save_revisions
  add column base_actions bigint check (base_actions >= 0),
  add column base_minute bigint check (base_minute >= 0),
  add column base_run bigint check (base_run >= 1),
  add column base_prestige_count bigint check (base_prestige_count >= 0);

-- A whole number at `path` in a save, or null.
create function private.save_number(p_data jsonb, p_path text[])
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_data #> p_path) = 'number'
      and (p_data #>> p_path) ~ '^[0-9]+$'
    then (p_data #>> p_path)::bigint
  end;
$$;

revoke execute on function private.save_number(jsonb, text[]) from public, anon, authenticated;

update private.save_revisions r
set base_actions = private.save_number(h.data, array['actions']),
    base_minute = private.save_number(h.data, array['clock', 'minute']),
    base_run = private.save_number(h.data, array['goals', 'run']),
    base_prestige_count = private.save_number(h.data, array['prestige', 'count'])
from (
  select distinct on (user_id, revision) user_id, revision, data
  from private.save_history
  order by user_id, revision, id desc
) h
where h.user_id = r.user_id and h.revision = r.revision;

-- As before, and the ledger row gets the save's baselines.
create or replace function public.commit_save(
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
  p_history_keep integer,
  p_ledger_keep integer
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
    or p_history_keep is null or p_history_keep < 1
    or p_ledger_keep is null or p_ledger_keep < 1 then
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

  insert into private.save_history (
    user_id, revision, save_version, data, device_id, accepted_at,
    burst_credit_minutes, pace_credit_cash, pace_credit_clout
  )
  values (
    p_user_id, v_revision, p_save_version, p_data, p_device_id, v_now,
    p_burst_credit_minutes, p_pace_credit_cash, p_pace_credit_clout
  );
  delete from private.save_history h
  where h.user_id = p_user_id
    and h.id not in (
      select k.id from private.save_history k
      where k.user_id = p_user_id
      order by k.id desc
      limit p_history_keep
    );

  insert into private.save_revisions (
    user_id, revision, accepted_at, burst_credit_minutes, pace_credit_cash, pace_credit_clout,
    base_actions, base_minute, base_run, base_prestige_count
  )
  values (
    p_user_id, v_revision, v_now, p_burst_credit_minutes, p_pace_credit_cash, p_pace_credit_clout,
    private.save_number(p_data, array['actions']),
    private.save_number(p_data, array['clock', 'minute']),
    private.save_number(p_data, array['goals', 'run']),
    private.save_number(p_data, array['prestige', 'count'])
  )
  on conflict (user_id, revision) do update
  set accepted_at = excluded.accepted_at,
      burst_credit_minutes = excluded.burst_credit_minutes,
      pace_credit_cash = excluded.pace_credit_cash,
      pace_credit_clout = excluded.pace_credit_clout,
      base_actions = excluded.base_actions,
      base_minute = excluded.base_minute,
      base_run = excluded.base_run,
      base_prestige_count = excluded.base_prestige_count;
  delete from private.save_revisions r
  where r.user_id = p_user_id and r.revision <= v_revision - p_ledger_keep;

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

drop function public.revision_at(uuid, bigint);

-- A revision the ledger keeps: when it was accepted, its credits and its baselines, or no row.
create function public.revision_at(p_user_id uuid, p_revision bigint)
returns table (
  accepted_at timestamptz,
  burst_credit_minutes double precision,
  pace_credit_cash double precision,
  pace_credit_clout double precision,
  base_actions bigint,
  base_minute bigint,
  base_run bigint,
  base_prestige_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.accepted_at, r.burst_credit_minutes, r.pace_credit_cash, r.pace_credit_clout,
    r.base_actions, r.base_minute, r.base_run, r.base_prestige_count
  from private.save_revisions r
  where r.user_id = p_user_id and r.revision = p_revision;
$$;

revoke execute on function public.revision_at(uuid, bigint) from public, anon, authenticated;
grant execute on function public.revision_at(uuid, bigint) to service_role;
