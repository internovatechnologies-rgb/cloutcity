-- S18b part 2: what the /mod console reads. The queue and one case, service-role only, like the
-- mod_* actions: the Next server routes (src/app/api/mod/*) check the caller against
-- MODERATOR_EMAILS and pass the moderator's own user id, which must be a permanent account.
-- Moderators see report notes and snapshots (the evidence); nothing here is ever shown to the
-- reported player or another reporter.
--
-- `create or replace` and plain revokes/grants keep it safe to run again on the shared local
-- stack, where it may already have been applied by hand.

-- The moderator id must be a real, non-guest account with an email (the same rule as mod_begin).
create or replace function private.mod_require_account(p_moderator_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_moderator_id is null or not exists (
    select 1 from auth.users u
    where u.id = p_moderator_id and not coalesce(u.is_anonymous, false) and u.email is not null
  ) then
    raise exception 'not_moderator' using errcode = 'PT403';
  end if;
end;
$$;

revoke execute on function private.mod_require_account(uuid) from public, anon, authenticated;

-- Open cases (a reported player with open reports), highest priority first, then oldest, plus
-- pending appeals, oldest first. p_limit caps each list (1..200).
create or replace function public.mod_queue(p_moderator_id uuid, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cases jsonb;
  v_appeals jsonb;
begin
  perform private.mod_require_account(p_moderator_id);
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;

  select coalesce(jsonb_agg(c.row order by c.priority desc, c.oldest_at, c.case_id), '[]'::jsonb)
  into v_cases
  from (
    select o.case_id, o.priority, o.oldest_at,
      jsonb_build_object(
        'case_id', o.case_id,
        'handle', p.handle,
        'priority', o.priority,
        'reports', o.reports,
        'reporters', o.reporters,
        'trusted_reporters', o.trusted_reporters,
        'brigade', o.brigade,
        'legal_hold', o.legal_hold,
        'reasons', to_jsonb(o.reasons),
        'oldest_at', o.oldest_at,
        'held', exists (
          select 1 from private.content_holds h
          where h.target_id = o.case_id and h.status = 'active'
        ),
        'standing', coalesce(private.active_sanction(o.case_id), 'good')
      ) as row
    from (
      select r.target_id as case_id,
        max(r.priority) as priority,
        count(*)::integer as reports,
        count(distinct r.reporter_id)::integer as reporters,
        (count(distinct r.reporter_id) filter (where r.trusted))::integer as trusted_reporters,
        bool_or(r.brigade) as brigade,
        bool_or(r.legal_hold) as legal_hold,
        min(r.created_at) as oldest_at,
        array_agg(distinct r.reason order by r.reason) as reasons
      from private.reports r
      where r.status = 'open'
      group by r.target_id
      order by max(r.priority) desc, min(r.created_at), r.target_id
      limit p_limit
    ) o
    left join public.profiles p on p.id = o.case_id
  ) c;

  select coalesce(jsonb_agg(a.row order by a.created_at, a.appeal_id), '[]'::jsonb)
  into v_appeals
  from (
    select ap.id as appeal_id, ap.created_at,
      jsonb_build_object(
        'appeal_id', ap.id,
        'user_id', ap.user_id,
        'handle', p.handle,
        'sanction_kind', s.kind,
        'sanction_reason', s.reason,
        'ends_at', s.ends_at,
        'body', ap.body,
        'created_at', ap.created_at
      ) as row
    from private.appeals ap
    join private.sanctions s on s.id = ap.sanction_id
    left join public.profiles p on p.id = ap.user_id
    where ap.status = 'pending'
    order by ap.created_at, ap.id
    limit p_limit
  ) a;

  return jsonb_build_object('cases', v_cases, 'appeals', v_appeals);
end;
$$;

-- One case: the reported player's public profile, their reports (newest first, at most 100,
-- with notes and snapshots), content holds, sanctions and the moderator history. A player who
-- was never reported is case_not_found (404).
create or replace function public.mod_case(p_moderator_id uuid, p_case uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.mod_require_account(p_moderator_id);
  if p_case is null then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  if not exists (select 1 from private.reports r where r.target_id = p_case) then
    raise exception 'case_not_found' using errcode = 'PT404';
  end if;

  return jsonb_build_object(
    'case_id', p_case,
    'profile', (
      select jsonb_build_object(
        'handle', p.handle,
        'public_level', p.public_level,
        'career_path', p.career_path,
        'created_at', p.created_at
      )
      from public.profiles p where p.id = p_case
    ),
    'standing', coalesce(private.active_sanction(p_case), 'good'),
    'reports', coalesce((
      select jsonb_agg(x.row order by x.created_at desc, x.id)
      from (
        select r.id, r.created_at,
          jsonb_build_object(
            'report_id', r.id,
            'reporter_id', r.reporter_id,
            'kind', r.kind,
            'reason', r.reason,
            'note', r.note,
            'snapshot', r.snapshot,
            'trusted', r.trusted,
            'brigade', r.brigade,
            'priority', r.priority,
            'legal_hold', r.legal_hold,
            'status', r.status,
            'created_at', r.created_at
          ) as row
        from private.reports r
        where r.target_id = p_case
        order by r.created_at desc, r.id
        limit 100
      ) x
    ), '[]'::jsonb),
    'holds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', h.kind, 'status', h.status, 'source', h.source, 'created_at', h.created_at
      ) order by h.created_at desc)
      from private.content_holds h where h.target_id = p_case
    ), '[]'::jsonb),
    'sanctions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', s.kind, 'reason', s.reason, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
        'revoked_at', s.revoked_at
      ) order by s.created_at desc)
      from private.sanctions s where s.user_id = p_case
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(x.row order by x.created_at desc)
      from (
        select m.created_at,
          jsonb_build_object(
            'action', m.action, 'reason', m.reason, 'created_at', m.created_at
          ) as row
        from private.moderation_audit m
        where m.case_id = p_case or m.target_id = p_case
        order by m.created_at desc
        limit 50
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.mod_queue(uuid, integer) from public, anon, authenticated;
grant execute on function public.mod_queue(uuid, integer) to service_role;
revoke execute on function public.mod_case(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mod_case(uuid, uuid) to service_role;
