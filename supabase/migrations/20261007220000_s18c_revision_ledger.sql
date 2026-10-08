-- S18c fix cycle 5 (N3): an untrimmed revision ledger.
--
-- private.save_history keeps only the last few full saves. "Keep this device" from a revision
-- whose full save was trimmed still needs that revision's time and credits, so every accepted
-- revision also gets a small row here: when it was accepted and the burst and honest-pace
-- credits it was stored with. commit_save writes it and keeps the newest p_ledger_keep rows per
-- player (sync.json revisionLedgerKeep).

create table private.save_revisions (
  user_id uuid not null references public.profiles (id) on delete cascade,
  revision bigint not null check (revision > 0),
  accepted_at timestamptz not null,
  burst_credit_minutes double precision not null check (burst_credit_minutes >= 0),
  pace_credit_cash double precision not null check (pace_credit_cash >= 0),
  pace_credit_clout double precision not null check (pace_credit_clout >= 0),
  primary key (user_id, revision)
);

alter table private.save_revisions enable row level security;
revoke all on table private.save_revisions from public, anon, authenticated, service_role;

-- Revisions accepted before the ledger existed: what the history still keeps.
insert into private.save_revisions (
  user_id, revision, accepted_at, burst_credit_minutes, pace_credit_cash, pace_credit_clout
)
select distinct on (h.user_id, h.revision) h.user_id, h.revision, h.accepted_at,
  h.burst_credit_minutes, h.pace_credit_cash, h.pace_credit_clout
from private.save_history h
order by h.user_id, h.revision, h.id desc
on conflict do nothing;

drop function public.commit_save(
  uuid, bigint, integer, jsonb, uuid, timestamptz, text, text, boolean, jsonb, jsonb,
  double precision, double precision, double precision, integer, integer, integer
);

-- As before, and the revision ledger gets a row (p_ledger_keep newest kept per player).
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
    user_id, revision, accepted_at, burst_credit_minutes, pace_credit_cash, pace_credit_clout
  )
  values (
    p_user_id, v_revision, v_now, p_burst_credit_minutes, p_pace_credit_cash, p_pace_credit_clout
  )
  on conflict (user_id, revision) do update
  set accepted_at = excluded.accepted_at,
      burst_credit_minutes = excluded.burst_credit_minutes,
      pace_credit_cash = excluded.pace_credit_cash,
      pace_credit_clout = excluded.pace_credit_clout;
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

revoke execute on function public.commit_save(
  uuid, bigint, integer, jsonb, uuid, timestamptz, text, text, boolean, jsonb, jsonb,
  double precision, double precision, double precision, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.commit_save(
  uuid, bigint, integer, jsonb, uuid, timestamptz, text, text, boolean, jsonb, jsonb,
  double precision, double precision, double precision, integer, integer, integer, integer
) to service_role;

-- A revision the ledger keeps: when it was accepted and its credits, or no row.
create function public.revision_at(p_user_id uuid, p_revision bigint)
returns table (
  accepted_at timestamptz,
  burst_credit_minutes double precision,
  pace_credit_cash double precision,
  pace_credit_clout double precision
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.accepted_at, r.burst_credit_minutes, r.pace_credit_cash, r.pace_credit_clout
  from private.save_revisions r
  where r.user_id = p_user_id and r.revision = p_revision;
$$;

revoke execute on function public.revision_at(uuid, bigint) from public, anon, authenticated;
grant execute on function public.revision_at(uuid, bigint) to service_role;
