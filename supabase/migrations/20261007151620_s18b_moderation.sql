-- S18b moderator actions and the retention purge.
--
-- The mod_* RPCs are service-role only: the /mod server routes (S18b part 2) check the caller
-- against MODERATOR_EMAILS and pass the moderator's own user id. Every action:
--   * takes p_moderator_id, p_case, an idempotency key and a correlation id;
--   * replays: the same key returns the first result and changes nothing (a different action or
--     case under that key is idempotency_conflict);
--   * locks what it resolves FOR UPDATE, so of two moderators resolving one case at once, the
--     second gets 409 already_resolved;
--   * writes exactly one private.moderation_audit row.
-- A case is a reported player: p_case is their id, and the case is every open report about them.
-- mod_resolve_appeal takes the appeal's id instead.
--
-- private.purge_expired_safety_data() applies data/config/moderation.json `retention` and never
-- touches anything under legal hold; pg_cron runs it daily.

-- Checks the shared arguments and the moderator, serialises on the idempotency key and returns
-- the stored result for a replay (null for a new action).
create function private.mod_begin(
  p_moderator_id uuid,
  p_action text,
  p_case uuid,
  p_idempotency_key text,
  p_correlation_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  if p_moderator_id is null or p_case is null
    or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,64}$'
    or p_correlation_id is null or p_correlation_id !~ '^[A-Za-z0-9_.:-]{1,128}$' then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  -- A moderator is a permanent account (the routes check the email allowlist); never a guest.
  if not exists (
    select 1 from auth.users u
    where u.id = p_moderator_id and not coalesce(u.is_anonymous, false) and u.email is not null
  ) then
    raise exception 'not_moderator' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('moderation:' || p_idempotency_key, 0));
  select a.action, a.case_id, a.result into v_row
  from private.moderation_audit a
  where a.idempotency_key = p_idempotency_key;
  if found then
    if v_row.action <> p_action or v_row.case_id <> p_case then
      raise exception 'idempotency_conflict' using errcode = 'PT409';
    end if;
    return v_row.result || jsonb_build_object('replayed', true);
  end if;
  return null;
end;
$$;

-- Locks the case's open reports. None open: already_resolved (409) if the player was ever
-- reported, case_not_found (404) if never.
create function private.mod_lock_open_reports(p_moderator_id uuid, p_case uuid)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := '{}';
  v_id uuid;
begin
  if p_case = p_moderator_id then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;
  for v_id in
    select r.id from private.reports r
    where r.target_id = p_case and r.status = 'open'
    order by r.id
    for update
  loop
    v_ids := v_ids || v_id;
  end loop;
  if cardinality(v_ids) = 0 then
    if exists (select 1 from private.reports r where r.target_id = p_case) then
      raise exception 'already_resolved' using errcode = 'PT409';
    end if;
    raise exception 'case_not_found' using errcode = 'PT404';
  end if;
  return v_ids;
end;
$$;

-- Closes the locked reports and updates their reporters' trust counters.
create function private.mod_close_reports(
  p_ids uuid[],
  p_status text,
  p_moderator_id uuid,
  p_abusive boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update private.reports r
  set status = p_status, resolved_at = now(), resolved_by = p_moderator_id,
      abusive = (p_status = 'dismissed' and p_abusive)
  where r.id = any (p_ids);

  if p_status = 'actioned' or p_abusive then
    insert into private.reporter_stats as s (user_id, actioned_reports, false_reports)
    select r.reporter_id,
      case when p_status = 'actioned' then 1 else 0 end,
      case when p_status = 'dismissed' and p_abusive then 1 else 0 end
    from (
      select distinct r.reporter_id from private.reports r
      where r.id = any (p_ids) and r.reporter_id is not null
    ) r
    on conflict (user_id) do update
    set actioned_reports = s.actioned_reports + excluded.actioned_reports,
        false_reports = s.false_reports + excluded.false_reports,
        updated_at = now();
  end if;
end;
$$;

-- Validates a moderator's reason (the report reason list) and optional internal note (blank
-- means none).
create function private.mod_check_reason(p_reason text, p_note text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_reason is null or p_reason not in (
    'harassment', 'hate', 'threats', 'sexual_content', 'self_harm', 'child_safety', 'spam',
    'scam', 'impersonation', 'offensive_name', 'personal_info', 'other'
  ) then
    raise exception 'invalid_reason' using errcode = 'PT400';
  end if;
  if char_length(btrim(p_note)) > 500 then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
end;
$$;

-- Live holds on the player's content: pending ones become upheld (the content stays hidden), or
-- every live one is released. Returns how many changed.
create function private.mod_settle_holds(p_case uuid, p_release boolean, p_moderator_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_release then
    update private.content_holds h
    set status = 'released', released_at = now(), released_by = p_moderator_id
    where h.target_id = p_case and h.status = 'active';
  else
    update private.content_holds h
    set status = 'upheld'
    where h.target_id = p_case and h.status = 'active';
  end if;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- A sanction plus the notice that tells the player about it.
create function private.mod_sanction(
  p_user_id uuid,
  p_kind text,
  p_reason text,
  p_ends_at timestamptz,
  p_moderator_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into private.sanctions (user_id, kind, reason, ends_at, created_by)
  values (p_user_id, p_kind, p_reason, p_ends_at, p_moderator_id)
  returning id into v_id;
  insert into public.account_notices (user_id, kind, reason, sanction_id, ends_at)
  values (p_user_id, p_kind, p_reason, v_id, p_ends_at);
  return v_id;
end;
$$;

create function private.mod_audit(
  p_action text,
  p_moderator_id uuid,
  p_case uuid,
  p_target uuid,
  p_idempotency_key text,
  p_correlation_id text,
  p_reason text,
  p_note text,
  p_report_ids uuid[],
  p_before jsonb,
  p_after jsonb,
  p_result jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into private.moderation_audit (
    action, moderator_id, case_id, target_id, idempotency_key, correlation_id, reason, note,
    report_ids, before, after, result
  ) values (
    p_action, p_moderator_id, p_case, p_target, p_idempotency_key, p_correlation_id, p_reason,
    nullif(btrim(p_note), ''), coalesce(p_report_ids, '{}'), coalesce(p_before, '{}'), coalesce(p_after, '{}'),
    p_result
  );
  return p_result;
end;
$$;

-- Where a report-resolving action leaves the case (the audit's before/after).
create function private.mod_case_state(p_case uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'open_reports', (
      select count(*) from private.reports r where r.target_id = p_case and r.status = 'open'
    ),
    'live_holds', (
      select count(*) from private.content_holds h
      where h.target_id = p_case and h.status <> 'released'
    ),
    'standing', coalesce(private.active_sanction(p_case), 'good')
  );
$$;

-- An email's peppered hash (Vault secret banned_identity_pepper), for banned_identities.
create function private.identity_hash(p_email text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(extensions.hmac(lower(btrim(p_email)), s.decrypted_secret, 'sha256'), 'hex')
  from vault.decrypted_secrets s
  where s.name = 'banned_identity_pepper';
$$;

-- For S19: whether an email belongs to a banned account (a lifted ban no longer counts).
create function private.is_banned_identity(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.banned_identities b
    where b.identity_hash = private.identity_hash(p_email) and b.lifted_at is null
  );
$$;

revoke execute on function private.mod_begin(uuid, text, uuid, text, text)
  from public, anon, authenticated;
revoke execute on function private.mod_lock_open_reports(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.mod_close_reports(uuid[], text, uuid, boolean)
  from public, anon, authenticated;
revoke execute on function private.mod_check_reason(text, text) from public, anon, authenticated;
revoke execute on function private.mod_settle_holds(uuid, boolean, uuid)
  from public, anon, authenticated;
revoke execute on function private.mod_sanction(uuid, text, text, timestamptz, uuid)
  from public, anon, authenticated;
revoke execute on function private.mod_audit(
  text, uuid, uuid, uuid, text, text, text, text, uuid[], jsonb, jsonb, jsonb
) from public, anon, authenticated;
revoke execute on function private.mod_case_state(uuid) from public, anon, authenticated;
revoke execute on function private.identity_hash(text) from public, anon, authenticated;
revoke execute on function private.is_banned_identity(text) from public, anon, authenticated;

-- Dismiss: closes the case without action and releases content hidden pending review. With
-- p_abusive, each reporter's false-report count goes up (falseReportThreshold ends their trust).
create function public.mod_dismiss(
  p_moderator_id uuid,
  p_case uuid,
  p_idempotency_key text,
  p_correlation_id text,
  p_abusive boolean,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_before jsonb;
  v_ids uuid[];
  v_holds integer;
begin
  v_result := private.mod_begin(
    p_moderator_id, 'dismiss', p_case, p_idempotency_key, p_correlation_id
  );
  if v_result is not null then
    return v_result;
  end if;
  if p_abusive is null or char_length(btrim(p_note)) > 500 then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  v_ids := private.mod_lock_open_reports(p_moderator_id, p_case);
  v_before := private.mod_case_state(p_case);
  perform private.mod_close_reports(v_ids, 'dismissed', p_moderator_id, p_abusive);
  v_holds := private.mod_settle_holds(p_case, true, p_moderator_id);
  v_result := jsonb_build_object(
    'action', 'dismiss', 'case', p_case, 'report_ids', to_jsonb(v_ids), 'abusive', p_abusive,
    'holds_released', v_holds, 'replayed', false
  );
  return private.mod_audit(
    'dismiss', p_moderator_id, p_case, p_case, p_idempotency_key, p_correlation_id, null, p_note,
    v_ids, v_before, private.mod_case_state(p_case), v_result
  );
end;
$$;

create function public.mod_warn(
  p_moderator_id uuid,
  p_case uuid,
  p_idempotency_key text,
  p_correlation_id text,
  p_reason text,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_before jsonb;
  v_ids uuid[];
  v_sanction uuid;
begin
  v_result := private.mod_begin(p_moderator_id, 'warn', p_case, p_idempotency_key, p_correlation_id);
  if v_result is not null then
    return v_result;
  end if;
  perform private.mod_check_reason(p_reason, p_note);
  v_ids := private.mod_lock_open_reports(p_moderator_id, p_case);
  v_before := private.mod_case_state(p_case);
  perform private.mod_close_reports(v_ids, 'actioned', p_moderator_id, false);
  perform private.mod_settle_holds(p_case, false, p_moderator_id);
  v_sanction := private.mod_sanction(p_case, 'warning', p_reason, null, p_moderator_id);
  v_result := jsonb_build_object(
    'action', 'warn', 'case', p_case, 'report_ids', to_jsonb(v_ids), 'sanction_id', v_sanction,
    'replayed', false
  );
  return private.mod_audit(
    'warn', p_moderator_id, p_case, p_case, p_idempotency_key, p_correlation_id, p_reason, p_note,
    v_ids, v_before, private.mod_case_state(p_case), v_result
  );
end;
$$;

-- Retires the player's handle for good (S18a's moderator_reset_handle) and gives them a fresh
-- generated one; the audit keeps the old handle in `before`.
create function public.mod_reset_handle(
  p_moderator_id uuid,
  p_case uuid,
  p_idempotency_key text,
  p_correlation_id text,
  p_reason text,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_before jsonb;
  v_ids uuid[];
  v_old text;
  v_new text;
  v_sanction uuid;
begin
  v_result := private.mod_begin(
    p_moderator_id, 'reset_handle', p_case, p_idempotency_key, p_correlation_id
  );
  if v_result is not null then
    return v_result;
  end if;
  perform private.mod_check_reason(p_reason, p_note);
  v_ids := private.mod_lock_open_reports(p_moderator_id, p_case);
  select p.handle into v_old from public.profiles p where p.id = p_case;
  v_before := private.mod_case_state(p_case) || jsonb_build_object('handle', v_old);
  perform private.mod_close_reports(v_ids, 'actioned', p_moderator_id, false);
  perform private.mod_settle_holds(p_case, false, p_moderator_id);
  v_new := public.moderator_reset_handle(p_case, p_reason);
  v_sanction := private.mod_sanction(p_case, 'handle_reset', p_reason, null, p_moderator_id);
  v_result := jsonb_build_object(
    'action', 'reset_handle', 'case', p_case, 'report_ids', to_jsonb(v_ids),
    'sanction_id', v_sanction, 'handle', v_new, 'replayed', false
  );
  return private.mod_audit(
    'reset_handle', p_moderator_id, p_case, p_case, p_idempotency_key, p_correlation_id, p_reason,
    p_note, v_ids, v_before, private.mod_case_state(p_case) || jsonb_build_object('handle', v_new),
    v_result
  );
end;
$$;

-- Restrict (no social features: friends, boosts, chat, emotes) or suspend (hidden from everyone,
-- no interaction) for p_days days.
create function private.mod_timed_sanction(
  p_action text,
  p_kind text,
  p_moderator_id uuid,
  p_case uuid,
  p_idempotency_key text,
  p_correlation_id text,
  p_reason text,
  p_days integer,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_before jsonb;
  v_ids uuid[];
  v_ends timestamptz;
  v_sanction uuid;
begin
  v_result := private.mod_begin(
    p_moderator_id, p_action, p_case, p_idempotency_key, p_correlation_id
  );
  if v_result is not null then
    return v_result;
  end if;
  perform private.mod_check_reason(p_reason, p_note);
  if p_days is null or p_days not between 1 and 365 then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  v_ids := private.mod_lock_open_reports(p_moderator_id, p_case);
  v_before := private.mod_case_state(p_case);
  perform private.mod_close_reports(v_ids, 'actioned', p_moderator_id, false);
  perform private.mod_settle_holds(p_case, false, p_moderator_id);
  v_ends := now() + make_interval(days => p_days);
  v_sanction := private.mod_sanction(p_case, p_kind, p_reason, v_ends, p_moderator_id);
  v_result := jsonb_build_object(
    'action', p_action, 'case', p_case, 'report_ids', to_jsonb(v_ids), 'sanction_id', v_sanction,
    'ends_at', v_ends, 'replayed', false
  );
  return private.mod_audit(
    p_action, p_moderator_id, p_case, p_case, p_idempotency_key, p_correlation_id, p_reason,
    p_note, v_ids, v_before, private.mod_case_state(p_case), v_result
  );
end;
$$;

revoke execute on function private.mod_timed_sanction(
  text, text, uuid, uuid, text, text, text, integer, text
) from public, anon, authenticated;

create function public.mod_restrict(
  p_moderator_id uuid,
  p_case uuid,
  p_idempotency_key text,
  p_correlation_id text,
  p_reason text,
  p_days integer,
  p_note text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.mod_timed_sanction(
    'restrict', 'restriction', p_moderator_id, p_case, p_idempotency_key, p_correlation_id,
    p_reason, p_days, p_note
  );
$$;

create function public.mod_suspend(
  p_moderator_id uuid,
  p_case uuid,
  p_idempotency_key text,
  p_correlation_id text,
  p_reason text,
  p_days integer,
  p_note text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.mod_timed_sanction(
    'suspend', 'suspension', p_moderator_id, p_case, p_idempotency_key, p_correlation_id,
    p_reason, p_days, p_note
  );
$$;

-- Permanent ban. The account's email (if it has one) is kept as a peppered hash so S19 can
-- refuse it again; an anonymous guest has none (RISK-4).
create function public.mod_ban(
  p_moderator_id uuid,
  p_case uuid,
  p_idempotency_key text,
  p_correlation_id text,
  p_reason text,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_before jsonb;
  v_ids uuid[];
  v_sanction uuid;
  v_email text;
  v_hash text;
begin
  v_result := private.mod_begin(p_moderator_id, 'ban', p_case, p_idempotency_key, p_correlation_id);
  if v_result is not null then
    return v_result;
  end if;
  perform private.mod_check_reason(p_reason, p_note);
  v_ids := private.mod_lock_open_reports(p_moderator_id, p_case);
  v_before := private.mod_case_state(p_case);
  perform private.mod_close_reports(v_ids, 'actioned', p_moderator_id, false);
  perform private.mod_settle_holds(p_case, false, p_moderator_id);
  v_sanction := private.mod_sanction(p_case, 'ban', p_reason, null, p_moderator_id);

  select u.email into v_email from auth.users u where u.id = p_case;
  if v_email is not null and btrim(v_email) <> '' then
    v_hash := private.identity_hash(v_email);
    if v_hash is null then
      raise exception 'banned_identity_pepper is missing from Vault' using errcode = 'P0001';
    end if;
    insert into private.banned_identities as b (identity_hash, kind, sanction_id)
    values (v_hash, 'email', v_sanction)
    on conflict (identity_hash) do update
    set sanction_id = excluded.sanction_id, lifted_at = null, created_at = now();
  end if;

  v_result := jsonb_build_object(
    'action', 'ban', 'case', p_case, 'report_ids', to_jsonb(v_ids), 'sanction_id', v_sanction,
    'identity_banned', v_hash is not null, 'replayed', false
  );
  return private.mod_audit(
    'ban', p_moderator_id, p_case, p_case, p_idempotency_key, p_correlation_id, p_reason, p_note,
    v_ids, v_before, private.mod_case_state(p_case), v_result
  );
end;
$$;

-- Decides an appeal (p_case is the appeal's id). Overturning revokes the sanction (and lifts a
-- ban's identity hash); either way the player gets a notice.
create function public.mod_resolve_appeal(
  p_moderator_id uuid,
  p_case uuid,
  p_idempotency_key text,
  p_correlation_id text,
  p_overturn boolean,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_appeal private.appeals;
  v_sanction private.sanctions;
begin
  v_result := private.mod_begin(
    p_moderator_id, 'resolve_appeal', p_case, p_idempotency_key, p_correlation_id
  );
  if v_result is not null then
    return v_result;
  end if;
  if p_overturn is null or char_length(btrim(p_note)) > 500 then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;

  select a.* into v_appeal from private.appeals a where a.id = p_case for update;
  if not found then
    raise exception 'case_not_found' using errcode = 'PT404';
  end if;
  if v_appeal.user_id = p_moderator_id then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;
  if v_appeal.status <> 'pending' then
    raise exception 'already_resolved' using errcode = 'PT409';
  end if;
  select s.* into v_sanction from private.sanctions s where s.id = v_appeal.sanction_id for update;

  update private.appeals a
  set status = case when p_overturn then 'overturned' else 'upheld' end,
      resolved_at = now(), resolved_by = p_moderator_id
  where a.id = p_case;

  if p_overturn then
    update private.sanctions s
    set revoked_at = now(), revoked_reason = 'appeal_overturned'
    where s.id = v_sanction.id and s.revoked_at is null;
    update private.banned_identities b
    set lifted_at = now()
    where b.sanction_id = v_sanction.id and b.lifted_at is null;
  end if;
  insert into public.account_notices (user_id, kind, reason, sanction_id)
  values (
    v_appeal.user_id,
    case when p_overturn then 'appeal_overturned' else 'appeal_upheld' end,
    v_sanction.reason,
    v_sanction.id
  );

  v_result := jsonb_build_object(
    'action', 'resolve_appeal', 'case', p_case, 'sanction_id', v_sanction.id,
    'overturned', p_overturn, 'replayed', false
  );
  return private.mod_audit(
    'resolve_appeal', p_moderator_id, p_case, v_appeal.user_id, p_idempotency_key,
    p_correlation_id, v_sanction.reason, p_note, '{}',
    jsonb_build_object('appeal', 'pending', 'sanction_kind', v_sanction.kind),
    jsonb_build_object(
      'appeal', case when p_overturn then 'overturned' else 'upheld' end,
      'sanction_revoked', p_overturn
    ),
    v_result
  );
end;
$$;

-- Puts every report about a player under legal hold (kept past retention, never purged) or takes
-- it off again. Child-safety reports always stay held.
create function public.mod_set_legal_hold(
  p_moderator_id uuid,
  p_case uuid,
  p_idempotency_key text,
  p_correlation_id text,
  p_hold boolean,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_before integer;
  v_after integer;
begin
  v_result := private.mod_begin(
    p_moderator_id, 'set_legal_hold', p_case, p_idempotency_key, p_correlation_id
  );
  if v_result is not null then
    return v_result;
  end if;
  if p_hold is null or char_length(btrim(p_note)) > 500 then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  if p_case = p_moderator_id then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;
  for v_id in
    select r.id from private.reports r where r.target_id = p_case order by r.id for update
  loop
    v_ids := v_ids || v_id;
  end loop;
  if cardinality(v_ids) = 0 then
    raise exception 'case_not_found' using errcode = 'PT404';
  end if;

  select count(*)::integer into v_before
  from private.reports r where r.id = any (v_ids) and r.legal_hold;
  update private.reports r
  set legal_hold = p_hold or r.reason = 'child_safety'
  where r.id = any (v_ids);
  select count(*)::integer into v_after
  from private.reports r where r.id = any (v_ids) and r.legal_hold;

  v_result := jsonb_build_object(
    'action', 'set_legal_hold', 'case', p_case, 'report_ids', to_jsonb(v_ids), 'hold', p_hold,
    'held_reports', v_after, 'replayed', false
  );
  return private.mod_audit(
    'set_legal_hold', p_moderator_id, p_case, p_case, p_idempotency_key, p_correlation_id, null,
    p_note, v_ids, jsonb_build_object('held_reports', v_before),
    jsonb_build_object('held_reports', v_after), v_result
  );
end;
$$;

revoke execute on function public.mod_dismiss(uuid, uuid, text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.mod_dismiss(uuid, uuid, text, text, boolean, text)
  to service_role;
revoke execute on function public.mod_warn(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mod_warn(uuid, uuid, text, text, text, text) to service_role;
revoke execute on function public.mod_reset_handle(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mod_reset_handle(uuid, uuid, text, text, text, text)
  to service_role;
revoke execute on function public.mod_restrict(uuid, uuid, text, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.mod_restrict(uuid, uuid, text, text, text, integer, text)
  to service_role;
revoke execute on function public.mod_suspend(uuid, uuid, text, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.mod_suspend(uuid, uuid, text, text, text, integer, text)
  to service_role;
revoke execute on function public.mod_ban(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mod_ban(uuid, uuid, text, text, text, text) to service_role;
revoke execute on function public.mod_resolve_appeal(uuid, uuid, text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.mod_resolve_appeal(uuid, uuid, text, text, boolean, text)
  to service_role;
revoke execute on function public.mod_set_legal_hold(uuid, uuid, text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.mod_set_legal_hold(uuid, uuid, text, text, boolean, text)
  to service_role;

-- NOTE-15: every handle reset now goes through mod_reset_handle, which writes the audit row.
-- S18a's function stays as its building block but no API role may call it directly.
revoke execute on function public.moderator_reset_handle(uuid, text) from service_role;

-- Retention (data/config/moderation.json `retention`, SEC-12 pending legal review). Open reports
-- are never purged; nothing about a player with any report under legal hold is purged.
create function private.purge_expired_safety_data()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settings private.moderation_settings := private.moderation_settings();
  v_evidence integer;
  v_reports integer;
  v_appeals integer;
  v_audit integer;
  v_undo integer;
  v_holds integer;
begin
  update private.reports r
  set snapshot = '{}'::jsonb, note = null, evidence_purged_at = now()
  where r.status <> 'open' and r.evidence_purged_at is null
    and r.resolved_at < now() - make_interval(days => v_settings.evidence_days)
    and not exists (
      select 1 from private.reports h where h.target_id = r.target_id and h.legal_hold
    );
  get diagnostics v_evidence = row_count;

  delete from private.reports r
  where r.status <> 'open'
    and r.resolved_at < now() - make_interval(days => v_settings.report_row_days)
    and not exists (
      select 1 from private.reports h where h.target_id = r.target_id and h.legal_hold
    );
  get diagnostics v_reports = row_count;

  delete from private.appeals a
  where a.status <> 'pending'
    and a.resolved_at < now() - make_interval(days => v_settings.appeal_days)
    and not exists (
      select 1 from private.reports h where h.target_id = a.user_id and h.legal_hold
    );
  get diagnostics v_appeals = row_count;

  perform set_config('cloutcity.audit_purge', 'on', true);
  delete from private.moderation_audit m
  where m.created_at < now() - make_interval(days => v_settings.audit_days)
    and not exists (
      select 1 from private.reports h where h.target_id = m.target_id and h.legal_hold
    );
  get diagnostics v_audit = row_count;
  perform set_config('cloutcity.audit_purge', 'off', true);

  delete from private.block_undo u where u.expires_at < now() - interval '1 day';
  get diagnostics v_undo = row_count;

  delete from private.content_holds h
  where h.status = 'released'
    and h.released_at < now() - make_interval(days => v_settings.evidence_days);
  get diagnostics v_holds = row_count;

  return jsonb_build_object(
    'evidence_purged', v_evidence, 'reports_deleted', v_reports, 'appeals_deleted', v_appeals,
    'audit_deleted', v_audit, 'undo_deleted', v_undo, 'holds_deleted', v_holds
  );
end;
$$;

revoke execute on function private.purge_expired_safety_data() from public, anon, authenticated;

-- Daily at 08:17 UTC (early morning in New York). cron.schedule replaces a job of the same name.
create extension if not exists pg_cron;
select cron.schedule(
  'purge-expired-safety-data',
  '17 8 * * *',
  'select private.purge_expired_safety_data()'
);
