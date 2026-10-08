-- S18b safety core: block, mute, report, the moderation tables and the standing gate.
--
-- Players see only their own blocks, mutes and account notices (owner-select RLS); every write
-- is a security-definer RPC. Reports, content holds, sanctions, appeals, reporter stats, the
-- moderation audit, block undo tokens, the settings and banned identities live in the private
-- schema: no client role can reach them, so a reporter never reads another report and a target
-- never learns who reported them.
--
-- Standing gate convention (alongside the attestation gate): every public function that
-- `authenticated` may execute either calls `private.require_good_standing(v_uid, '<capability>')`
-- right after the attestation gate, or is tagged `@standing-exempt: <reason>` on a line of its
-- comment. tests/integration/catalog.test.ts enforces it. Capabilities:
--   interact  refused while suspended or banned (block, mute, set a handle)
--   social    also refused while restricted (friend boosts; S20+ friends, chat, emotes)
--
-- The moderator actions (mod_*) and the retention purge are in the next migration.

-- Settings: a copy of data/config/moderation.json (tests/integration/safety.test.ts checks it).
create table private.moderation_settings (
  id boolean primary key default true check (id),
  auto_hide_reports integer not null check (auto_hide_reports > 0),
  auto_hide_reporter_min_hours integer not null check (auto_hide_reporter_min_hours >= 0),
  false_report_threshold integer not null check (false_report_threshold > 0),
  reports_per_day integer not null check (reports_per_day > 0),
  note_max_chars integer not null check (note_max_chars between 1 and 1000),
  appeal_max_chars integer not null check (appeal_max_chars between 1 and 2000),
  block_undo_seconds integer not null check (block_undo_seconds > 0),
  block_max integer not null check (block_max > 0),
  mute_max integer not null check (mute_max > 0),
  evidence_days integer not null check (evidence_days > 0),
  report_row_days integer not null check (report_row_days >= evidence_days),
  audit_days integer not null check (audit_days > 0),
  appeal_days integer not null check (appeal_days > 0)
);

insert into private.moderation_settings (
  auto_hide_reports, auto_hide_reporter_min_hours, false_report_threshold, reports_per_day,
  note_max_chars, appeal_max_chars, block_undo_seconds, block_max, mute_max,
  evidence_days, report_row_days, audit_days, appeal_days
) values (3, 24, 3, 20, 280, 500, 10, 1000, 1000, 180, 730, 730, 180);

create function private.moderation_settings()
returns private.moderation_settings
language sql
stable
security definer
set search_path = ''
as $$
  select s.* from private.moderation_settings s where s.id;
$$;

-- Blocks and mutes: the owner reads their own list; the RPCs below write it.
create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);

create index blocks_blocked_id_idx on public.blocks (blocked_id);

create table public.mutes (
  muter_id uuid not null references public.profiles (id) on delete cascade,
  muted_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (muter_id, muted_id),
  constraint mutes_not_self check (muter_id <> muted_id)
);

create index mutes_muted_id_idx on public.mutes (muted_id);

-- What a player is told about moderator decisions on their account. No moderator, reporter or
-- note is ever named here.
create table public.account_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in (
    'warning', 'handle_reset', 'restriction', 'suspension', 'ban', 'appeal_upheld',
    'appeal_overturned'
  )),
  -- The Code of Conduct reason (the report reason list).
  reason text check (reason in (
    'harassment', 'hate', 'threats', 'sexual_content', 'self_harm', 'child_safety', 'spam',
    'scam', 'impersonation', 'offensive_name', 'personal_info', 'other'
  )),
  -- The sanction an appeal would be about (private.sanctions; not a foreign key across the
  -- schema boundary, so a purge there never touches the player's notices).
  sanction_id uuid,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

create index account_notices_user_created_idx on public.account_notices (user_id, created_at desc);

alter table public.blocks enable row level security;
alter table public.mutes enable row level security;
alter table public.account_notices enable row level security;

revoke all on table public.blocks, public.mutes, public.account_notices from anon, authenticated;
grant select on table public.blocks, public.mutes, public.account_notices to authenticated;

create policy blocks_select_own on public.blocks
  for select to authenticated
  using (blocker_id = (select auth.uid()));

create policy mutes_select_own on public.mutes
  for select to authenticated
  using (muter_id = (select auth.uid()));

create policy account_notices_select_own on public.account_notices
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Reports. The ids are not foreign keys to the target: evidence about a player outlives their
-- account until the retention purge (or never, under legal hold). A deleted reporter is unlinked.
create table private.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles (id) on delete set null,
  target_id uuid not null,
  -- S20a adds 'message'.
  kind text not null check (kind in ('player', 'handle')),
  reason text not null check (reason in (
    'harassment', 'hate', 'threats', 'sexual_content', 'self_harm', 'child_safety', 'spam',
    'scam', 'impersonation', 'offensive_name', 'personal_info', 'other'
  )),
  note text check (char_length(note) between 1 and 1000),
  -- What the reported thing looked like when it was reported, captured by the server.
  snapshot jsonb not null
    check (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 16384),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  -- The New York day it was filed on, for the daily limit (city time).
  ny_day date not null,
  -- Whether the reporter counted toward auto-hide when they filed it.
  trusted boolean not null,
  -- Set when enough untrusted reporters pile onto one player to look like a brigade.
  brigade boolean not null default false,
  priority integer not null,
  legal_hold boolean not null default false,
  status text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  -- A moderator judged the report abusive (counts against the reporter's trust).
  abusive boolean not null default false,
  resolved_at timestamptz,
  resolved_by uuid,
  evidence_purged_at timestamptz,
  created_at timestamptz not null default now(),
  constraint reports_not_self check (reporter_id is distinct from target_id),
  constraint reports_resolution check ((status = 'open') = (resolved_at is null)),
  constraint reports_child_safety_held check (reason <> 'child_safety' or legal_hold),
  constraint reports_abusive_dismissed check (not abusive or status = 'dismissed')
);

create unique index reports_reporter_key on private.reports (reporter_id, idempotency_key);
-- One open report per reporter, target, kind and reason: a repeat is the same report.
create unique index reports_one_open on private.reports (reporter_id, target_id, kind, reason)
  where status = 'open';
create index reports_target_status_idx on private.reports (target_id, status);
create index reports_reporter_day_idx on private.reports (reporter_id, ny_day);
create index reports_queue_idx on private.reports (priority desc, created_at)
  where status = 'open';

-- Content hidden from other players pending review (auto-hide) or after a moderator upheld it.
-- Only content: a player is never hidden by reports alone.
create table private.content_holds (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.profiles (id) on delete cascade,
  -- S20a adds 'message'.
  kind text not null check (kind in ('handle')),
  -- For a handle, its handle_key.
  content_key text not null check (content_key <> ''),
  status text not null default 'active' check (status in ('active', 'upheld', 'released')),
  source text not null check (source in ('auto', 'moderator')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid,
  constraint content_holds_release check ((status = 'released') = (released_at is not null))
);

create unique index content_holds_one_live on private.content_holds (target_id, kind, content_key)
  where status <> 'released';

create table private.sanctions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null
    check (kind in ('warning', 'handle_reset', 'restriction', 'suspension', 'ban')),
  reason text not null check (reason in (
    'harassment', 'hate', 'threats', 'sexual_content', 'self_harm', 'child_safety', 'spam',
    'scam', 'impersonation', 'offensive_name', 'personal_info', 'other'
  )),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('appeal_overturned')),
  created_at timestamptz not null default now(),
  constraint sanctions_suspension_ends check (kind <> 'suspension' or ends_at is not null),
  constraint sanctions_ban_permanent check (kind <> 'ban' or ends_at is null),
  constraint sanctions_ends_after_start check (ends_at is null or ends_at > starts_at),
  constraint sanctions_revoke_pair check ((revoked_at is null) = (revoked_reason is null))
);

create index sanctions_user_id_idx on private.sanctions (user_id);

-- One appeal per sanction.
create table private.appeals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  sanction_id uuid not null unique references private.sanctions (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  status text not null default 'pending' check (status in ('pending', 'upheld', 'overturned')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  constraint appeals_resolution check ((status = 'pending') = (resolved_at is null))
);

create index appeals_user_id_idx on private.appeals (user_id);
create index appeals_pending_idx on private.appeals (created_at) where status = 'pending';

create table private.reporter_stats (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  reports_total integer not null default 0 check (reports_total >= 0),
  actioned_reports integer not null default 0 check (actioned_reports >= 0),
  false_reports integer not null default 0 check (false_reports >= 0),
  updated_at timestamptz not null default now()
);

-- One row per moderator action, never changed. Ids are not foreign keys: the record outlives
-- the accounts it is about until the retention purge.
create table private.moderation_audit (
  id bigint generated always as identity primary key,
  action text not null check (action in (
    'dismiss', 'warn', 'reset_handle', 'restrict', 'suspend', 'ban', 'resolve_appeal',
    'set_legal_hold'
  )),
  moderator_id uuid not null,
  -- The reported player's id, or the appeal's id for resolve_appeal.
  case_id uuid not null,
  target_id uuid,
  idempotency_key text not null unique check (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  correlation_id text not null check (correlation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  reason text,
  note text check (char_length(note) between 1 and 500),
  report_ids uuid[] not null default '{}',
  before jsonb not null default '{}'::jsonb,
  after jsonb not null default '{}'::jsonb,
  -- What the RPC returned, so a replay with the same idempotency key returns it again.
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index moderation_audit_target_idx on private.moderation_audit (target_id, created_at);
create index moderation_audit_created_idx on private.moderation_audit (created_at);

-- The audit is append-only for everyone, the table owner included. The retention purge
-- (private.purge_expired_safety_data) is the one path that deletes, by setting a
-- transaction-local flag first.
create function private.moderation_audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('cloutcity.audit_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'moderation_audit_append_only' using errcode = 'P0001';
end;
$$;

create trigger moderation_audit_append_only
  before update or delete on private.moderation_audit
  for each row execute function private.moderation_audit_append_only();

create trigger moderation_audit_no_truncate
  before truncate on private.moderation_audit
  for each statement execute function private.moderation_audit_append_only();

-- What block_player removed, so unblock_player can put it back within the undo window.
create table private.block_undo (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  -- The deleted friendships row, as JSON.
  friendship jsonb,
  -- The roommate link that was active and got ended.
  roommate_id uuid,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index block_undo_blocker_idx on private.block_undo (blocker_id);

-- Banned accounts' emails, as peppered hashes only, so a ban survives account deletion and S19
-- can refuse the same email on upgrade (RISK-4: an anonymous guest has no email to ban).
create table private.banned_identities (
  identity_hash text primary key check (identity_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('email')),
  sanction_id uuid not null,
  created_at timestamptz not null default now(),
  lifted_at timestamptz
);

alter table private.moderation_settings enable row level security;
alter table private.reports enable row level security;
alter table private.content_holds enable row level security;
alter table private.sanctions enable row level security;
alter table private.appeals enable row level security;
alter table private.reporter_stats enable row level security;
alter table private.moderation_audit enable row level security;
alter table private.block_undo enable row level security;
alter table private.banned_identities enable row level security;
revoke all on table private.moderation_settings, private.reports, private.content_holds,
  private.sanctions, private.appeals, private.reporter_stats, private.moderation_audit,
  private.block_undo, private.banned_identities
  from public, anon, authenticated, service_role;

-- The pepper for banned identities, kept in Vault (created once; never in a migration file).
do $$
begin
  if not exists (select 1 from vault.secrets s where s.name = 'banned_identity_pepper') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'banned_identity_pepper',
      'S18b: HMAC key for private.banned_identities'
    );
  end if;
end;
$$;

-- Helpers. normalize_text and contains_contact_info have a TypeScript twin in
-- src/lib/safety/textFilter.ts (src/lib/safety/parity.test.ts and the integration suite hold them
-- together); S20a's chat filter reuses them.

create function private.normalize_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      translate(
        normalize(p_text, NFKC),
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'abcdefghijklmnopqrstuvwxyz'
      ),
      '[\t\n\u000B\f\r\u0085\u2028\u2029 ]+',
      ' ',
      'g'
    ),
    ' '
  );
$$;

-- Links, emails, phone numbers, social handles and hidden characters. Insults are not refused:
-- in a report note they are the evidence.
create function private.contains_contact_info(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is not null and (
    p_text ~ '[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]'
    or exists (
      select 1
      from unnest(array[
        '[a-z][a-z0-9+.-]*://',
        '(^|[^a-z0-9])www(\.| ?\(dot\) ?| ?\[dot\] ?| dot )',
        '[a-z0-9-]+(\.| ?\(dot\) ?| ?\[dot\] ?| dot )(com|net|org|io|gg|ly|co|app|xyz|tv|me|info|link|live|dev|uk|ca)([^a-z0-9]|$)',
        '[a-z0-9._%+-]+ ?(@|\(at\)|\[at\]) ?[a-z0-9-]+(\.| ?\(dot\) ?| ?\[dot\] ?| dot )[a-z]{2,}',
        '(^|[^a-z0-9_.])@[a-z0-9_.]{2,}',
        '(^|[^a-z0-9])(instagram|insta|ig|snapchat|snap|tiktok|twitter|telegram|whatsapp|discord|kik|venmo|cashapp) ?(:|=) ?[a-z0-9_.]{2,}',
        '[0-9]([ ().+-]{0,2}[0-9]){6,}'
      ]) as c(pattern)
      where private.normalize_text(p_text) ~ c.pattern
    )
  );
$$;

create function private.is_blocked_either(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b) or (b.blocker_id = p_b and b.blocked_id = p_a)
  );
$$;

-- Everyone the player blocked or was blocked by, for snapshot and list filters (S29, S20).
create function private.blocked_ids_either(p_uid uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.blocked_id from public.blocks b where b.blocker_id = p_uid
  union
  select b.blocker_id from public.blocks b where b.blocked_id = p_uid;
$$;

-- The strongest sanction in force: 'ban', 'suspension', 'restriction' or null.
create function private.active_sanction(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.kind
  from private.sanctions s
  where s.user_id = p_uid
    and s.kind in ('ban', 'suspension', 'restriction')
    and s.revoked_at is null
    and s.starts_at <= now()
    and (s.ends_at is null or s.ends_at > now())
  order by case s.kind when 'ban' then 1 when 'suspension' then 2 else 3 end
  limit 1;
$$;

-- The standing gate (see the header). Raises 403 account_banned / account_suspended, or
-- account_restricted for a 'social' capability.
create function private.require_good_standing(p_uid uuid, p_capability text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  if p_capability is null or p_capability not in ('interact', 'social') then
    raise exception 'unknown_capability' using errcode = 'P0001';
  end if;
  v_kind := private.active_sanction(p_uid);
  if v_kind = 'ban' then
    raise exception 'account_banned' using errcode = 'PT403';
  end if;
  if v_kind = 'suspension' then
    raise exception 'account_suspended' using errcode = 'PT403';
  end if;
  if v_kind = 'restriction' and p_capability = 'social' then
    raise exception 'account_restricted' using errcode = 'PT403';
  end if;
end;
$$;

-- Whether the player's current handle is hidden from others (a live content hold on it).
create function private.handle_held(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join private.content_holds h
      on h.target_id = p.id and h.kind = 'handle' and h.content_key = private.handle_key(p.handle)
    where p.id = p_uid and h.status <> 'released'
  );
$$;

-- A reporter counts toward auto-hide once their account is old enough and few of their reports
-- were judged abusive.
create function private.reporter_trusted(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    cross join private.moderation_settings() s
    left join private.reporter_stats r on r.user_id = p.id
    where p.id = p_uid
      and p.created_at <= now() - make_interval(hours => s.auto_hide_reporter_min_hours)
      and coalesce(r.false_reports, 0) < s.false_report_threshold
  );
$$;

-- Queue order: child safety first, then self-harm, then threats, then everything else.
create function private.report_priority(p_reason text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_reason
    when 'child_safety' then 100
    when 'self_harm' then 90
    when 'threats' then 80
    else 10
  end;
$$;

-- What the reported thing looked like, captured by the server (never sent by the client). S20a
-- adds a message kind.
create function private.report_snapshot(p_kind text, p_target uuid, p_reporter uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'kind', p_kind,
    'captured_at', now(),
    'target_id', p.id,
    'handle', p.handle,
    'handle_key', private.handle_key(p.handle),
    'public_level', p.public_level,
    'career_path', p.career_path,
    'account_created_at', p.created_at,
    'friends', private.are_friends(p_reporter, p_target),
    'reporter_blocked_target', exists (
      select 1 from public.blocks b where b.blocker_id = p_reporter and b.blocked_id = p_target
    )
  ) || case when p_kind = 'player' then jsonb_build_object('avatar', p.avatar) else '{}'::jsonb end
  from public.profiles p
  where p.id = p_target;
$$;

-- S18a's stub, now real: a player sees another unless either blocked the other, or the other is
-- suspended or banned. A player always sees themselves.
create or replace function private.can_view(p_viewer uuid, p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null
    and exists (select 1 from public.profiles p where p.id = p_target and p.attested)
    and (
      p_viewer = p_target
      or (
        not private.is_blocked_either(p_viewer, p_target)
        and coalesce(private.active_sanction(p_target) not in ('ban', 'suspension'), true)
      )
    );
$$;

-- The handle other players may see: the neutral placeholder while it is under a content hold
-- (src/lib/safety/reports.ts HELD_HANDLE_PLACEHOLDER; `player` is an exact blocklist term, so no
-- real handle can look like it).
create or replace function private.public_handle(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when p.handle is not null and private.handle_held(p.id) then 'Player' else p.handle end
  from public.profiles p
  where p.id = p_uid and p.attested;
$$;

revoke execute on function private.moderation_settings() from public, anon, authenticated;
revoke execute on function private.moderation_audit_append_only() from public, anon, authenticated;
revoke execute on function private.normalize_text(text) from public, anon, authenticated;
revoke execute on function private.contains_contact_info(text) from public, anon, authenticated;
revoke execute on function private.is_blocked_either(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.blocked_ids_either(uuid) from public, anon, authenticated;
revoke execute on function private.active_sanction(uuid) from public, anon, authenticated;
revoke execute on function private.require_good_standing(uuid, text)
  from public, anon, authenticated;
revoke execute on function private.handle_held(uuid) from public, anon, authenticated;
revoke execute on function private.reporter_trusted(uuid) from public, anon, authenticated;
revoke execute on function private.report_priority(text) from public, anon, authenticated;
revoke execute on function private.report_snapshot(text, uuid, uuid)
  from public, anon, authenticated;

-- S18 and S18a client RPCs under the standing gate.

-- A boost now also needs the sender in good standing and the friend visible to them.
create or replace function public.send_friend_boost(p_to uuid)
returns table (boost_id bigint, ny_day date)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
  v_day date;
  v_id bigint;
begin
  v_uid := private.require_attestation();
  perform private.require_good_standing(v_uid, 'social');
  if p_to is null or p_to = v_uid then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;
  -- Unknown, unattested, suspended and banned players get the same answer, so the RPC reveals
  -- nothing about them.
  if not private.can_view(v_uid, p_to) then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;
  if not private.are_friends(v_uid, p_to) then
    raise exception 'not_friends' using errcode = 'PT403';
  end if;

  v_day := private.ny_today();
  insert into public.friend_boosts (sender_id, recipient_id, ny_day)
  values (v_uid, p_to, v_day)
  on conflict (sender_id, ny_day) do nothing
  returning id into v_id;

  if v_id is null then
    raise exception 'boost_already_sent' using errcode = 'PT409';
  end if;

  boost_id := v_id;
  ny_day := v_day;
  return next;
end;
$$;

-- Choosing a handle needs the player not suspended or banned (a restricted player may still fix
-- one that got them restricted).
create or replace function public.set_handle(p_handle text)
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
  perform private.require_good_standing(v_uid, 'interact');
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

-- A handle under a content hold cannot be looked up: the same 404 as an unknown one.
create or replace function public.get_public_profile(p_handle text)
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
      and private.can_view(v_uid, p.id)
      and not private.handle_held(p.id);
  if not found then
    raise exception 'profile_not_found' using errcode = 'PT404';
  end if;
end;
$$;

-- Players seen in the city: a held handle shows as the placeholder.
create or replace function public.get_public_profiles(p_ids uuid[])
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
    select p.id, private.public_handle(p.id), p.public_level, p.career_path, p.avatar
    from public.profiles p
    where p.id = any (p_ids)
      and p.attested
      and p.handle is not null
      and private.can_view(v_uid, p.id)
    order by p.id;
end;
$$;

comment on function public.attest_and_consent(boolean, timestamptz, text, timestamptz, text) is
  E'@attestation-exempt: records the attestation itself\n@standing-exempt: a sanctioned account may still record its attestation';
comment on function public.set_audio_choice(text) is
  E'@attestation-exempt: a private sound preference, neither social, realtime nor purchase\n@standing-exempt: a private sound preference';
comment on function public.assert_attested() is
  '@standing-exempt: checks the attestation gate only';
comment on function public.get_my_profile() is
  '@standing-exempt: reads the caller''s own profile';
comment on function public.check_handle(text) is
  '@standing-exempt: read-only availability check; set_handle is gated';
comment on function public.get_public_profile(text) is
  '@standing-exempt: read-only; suspended and banned players are hidden by can_view';
comment on function public.get_public_profiles(uuid[]) is
  '@standing-exempt: read-only; suspended and banned players are hidden by can_view';

-- Block: hides both ways (can_view), and in one transaction ends the friendship (any request
-- too) and the roommate link. Returns an undo token valid for blockUndoSeconds.
create function public.block_player(p_target uuid)
returns table (
  undo_id uuid,
  undo_expires_at timestamptz,
  friendship_ended boolean,
  roommate_ended boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
  v_settings private.moderation_settings;
  v_friend public.friendships;
  v_room uuid;
  v_count integer;
begin
  v_uid := private.require_attestation();
  perform private.require_good_standing(v_uid, 'interact');
  if p_target is null or p_target = v_uid
    or not exists (select 1 from public.profiles p where p.id = p_target and p.attested) then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;

  -- Serialises this player's blocks, so the cap cannot be raced.
  perform 1 from public.profiles p where p.id = v_uid for update;

  undo_id := null;
  undo_expires_at := null;
  friendship_ended := false;
  roommate_ended := false;
  if exists (
    select 1 from public.blocks b where b.blocker_id = v_uid and b.blocked_id = p_target
  ) then
    return next;
    return;
  end if;

  v_settings := private.moderation_settings();
  select count(*)::integer into v_count from public.blocks b where b.blocker_id = v_uid;
  if v_count >= v_settings.block_max then
    raise exception 'block_limit' using errcode = 'PT409';
  end if;

  insert into public.blocks (blocker_id, blocked_id) values (v_uid, p_target);

  delete from public.friendships f
  where least(f.requester_id, f.addressee_id) = least(v_uid, p_target)
    and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_target)
  returning f.* into v_friend;

  select r.id into v_room
  from public.roommates r
  where r.user_low = least(v_uid, p_target) and r.user_high = greatest(v_uid, p_target)
    and r.status = 'active'
  for update;
  update public.roommates r
  set status = 'ended', ended_at = now()
  where r.user_low = least(v_uid, p_target) and r.user_high = greatest(v_uid, p_target)
    and r.status in ('pending', 'active');

  undo_expires_at := now() + make_interval(secs => v_settings.block_undo_seconds);
  insert into private.block_undo (blocker_id, blocked_id, friendship, roommate_id, expires_at)
  values (
    v_uid,
    p_target,
    case when v_friend.id is null then null else to_jsonb(v_friend) end,
    v_room,
    undo_expires_at
  )
  returning id into undo_id;

  friendship_ended := coalesce(v_friend.status = 'accepted', false);
  roommate_ended := v_room is not null;
  return next;
end;
$$;

-- Unblock. With the block's undo token, inside its window and while neither has blocked the
-- other since, the friendship and the roommate link come back as they were.
create function public.unblock_player(p_target uuid, p_undo uuid default null)
returns table (unblocked boolean, friendship_restored boolean, roommate_restored boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
  v_undo private.block_undo;
  v_rows integer;
begin
  v_uid := private.require_attestation();
  perform private.require_good_standing(v_uid, 'interact');
  if p_target is null or p_target = v_uid then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;

  delete from public.blocks b where b.blocker_id = v_uid and b.blocked_id = p_target;
  get diagnostics v_rows = row_count;
  unblocked := v_rows > 0;
  friendship_restored := false;
  roommate_restored := false;

  if unblocked and p_undo is not null then
    update private.block_undo u
    set used_at = now()
    where u.id = p_undo and u.blocker_id = v_uid and u.blocked_id = p_target
      and u.used_at is null and u.expires_at > now()
    returning u.* into v_undo;

    if v_undo.id is not null and not private.is_blocked_either(v_uid, p_target) then
      if v_undo.friendship is not null then
        insert into public.friendships
        select * from jsonb_populate_record(null::public.friendships, v_undo.friendship)
        on conflict do nothing;
        friendship_restored := found;
      end if;
      if v_undo.roommate_id is not null then
        begin
          update public.roommates r
          set status = 'active', ended_at = null
          where r.id = v_undo.roommate_id and r.status = 'ended';
          roommate_restored := found;
        exception when unique_violation then
          -- One of them moved in with someone else meanwhile: the link stays ended.
          roommate_restored := false;
        end;
      end if;
    end if;
  end if;
  return next;
end;
$$;

-- Mute: hides that player's avatar and emotes for the caller only.
create function public.mute_player(p_target uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_count integer;
begin
  v_uid := private.require_attestation();
  perform private.require_good_standing(v_uid, 'interact');
  if p_target is null or p_target = v_uid
    or not exists (select 1 from public.profiles p where p.id = p_target and p.attested) then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;

  -- Serialises this player's mutes, so the cap cannot be raced.
  perform 1 from public.profiles p where p.id = v_uid for update;
  if exists (select 1 from public.mutes m where m.muter_id = v_uid and m.muted_id = p_target) then
    return;
  end if;
  select count(*)::integer into v_count from public.mutes m where m.muter_id = v_uid;
  if v_count >= (private.moderation_settings()).mute_max then
    raise exception 'mute_limit' using errcode = 'PT409';
  end if;
  insert into public.mutes (muter_id, muted_id) values (v_uid, p_target);
end;
$$;

create function public.unmute_player(p_target uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  v_uid := private.require_attestation();
  perform private.require_good_standing(v_uid, 'interact');
  if p_target is null then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;
  delete from public.mutes m where m.muter_id = v_uid and m.muted_id = p_target;
end;
$$;

-- The caller's block and mute lists, newest first, with the handles others would see.
create function public.list_my_blocks()
returns table (player_id uuid, handle text, blocked_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
begin
  v_uid := private.require_attestation();
  return query
    select b.blocked_id, private.public_handle(b.blocked_id), b.created_at
    from public.blocks b
    where b.blocker_id = v_uid
    order by b.created_at desc, b.blocked_id;
end;
$$;

create function public.list_my_mutes()
returns table (player_id uuid, handle text, muted_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
begin
  v_uid := private.require_attestation();
  return query
    select m.muted_id, private.public_handle(m.muted_id), m.created_at
    from public.mutes m
    where m.muter_id = v_uid
    order by m.created_at desc, m.muted_id;
end;
$$;

-- Files a report. The note is optional, at most noteMaxChars, and may not carry contact details
-- (insults are allowed: they are the evidence). The snapshot is taken here, never sent. A repeat
-- (same idempotency key, or the same open report) returns the first one and counts once.
create function public.submit_report(
  p_target uuid,
  p_kind text,
  p_reason text,
  p_note text,
  p_idempotency_key text
)
returns table (report_id uuid, duplicate boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
  v_settings private.moderation_settings;
  v_note text;
  v_existing uuid;
  v_today date;
  v_count integer;
  v_snapshot jsonb;
  v_trusted boolean;
  v_key text;
begin
  v_uid := private.require_attestation();
  if p_kind is null or p_kind not in ('player', 'handle') then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  if p_reason is null or p_reason not in (
    'harassment', 'hate', 'threats', 'sexual_content', 'self_harm', 'child_safety', 'spam',
    'scam', 'impersonation', 'offensive_name', 'personal_info', 'other'
  ) or (p_kind = 'handle' and p_reason not in (
    'offensive_name', 'hate', 'harassment', 'sexual_content', 'impersonation', 'other'
  )) then
    raise exception 'invalid_reason' using errcode = 'PT400';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;

  v_settings := private.moderation_settings();
  v_note := nullif(btrim(p_note), '');
  if char_length(v_note) > v_settings.note_max_chars then
    raise exception 'note_too_long' using errcode = 'PT400';
  end if;
  if private.contains_contact_info(v_note) then
    raise exception 'note_contact_info' using errcode = 'PT400';
  end if;

  if p_target = v_uid then
    raise exception 'self_report' using errcode = 'PT400';
  end if;
  if p_target is null
    or not exists (select 1 from public.profiles p where p.id = p_target and p.attested) then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;

  -- Serialises the reporter (limit, duplicates), then the target (auto-hide counts).
  perform pg_advisory_xact_lock(hashtextextended('report-reporter:' || v_uid::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('report-target:' || p_target::text, 0));

  select r.id into v_existing
  from private.reports r
  where r.reporter_id = v_uid
    and (
      r.idempotency_key = p_idempotency_key
      or (r.status = 'open' and r.target_id = p_target and r.kind = p_kind and r.reason = p_reason)
    )
  limit 1;
  if v_existing is not null then
    report_id := v_existing;
    duplicate := true;
    return next;
    return;
  end if;

  v_today := private.ny_today();
  select count(*)::integer into v_count
  from private.reports r
  where r.reporter_id = v_uid and r.ny_day = v_today;
  if v_count >= v_settings.reports_per_day then
    raise exception 'rate_limited' using errcode = 'PT429';
  end if;

  v_snapshot := private.report_snapshot(p_kind, p_target, v_uid);
  v_trusted := private.reporter_trusted(v_uid);
  insert into private.reports (
    reporter_id, target_id, kind, reason, note, snapshot, idempotency_key, ny_day, trusted,
    priority, legal_hold
  ) values (
    v_uid, p_target, p_kind, p_reason, v_note, v_snapshot, p_idempotency_key, v_today, v_trusted,
    private.report_priority(p_reason), p_reason = 'child_safety'
  )
  returning id into report_id;

  insert into private.reporter_stats as s (user_id, reports_total)
  values (v_uid, 1)
  on conflict (user_id) do update set reports_total = s.reports_total + 1, updated_at = now();

  -- Auto-hide: content only (a handle), and only once enough distinct trusted reporters have
  -- open reports on that same handle.
  v_key := v_snapshot ->> 'handle_key';
  if p_kind = 'handle' and v_key is not null then
    select count(distinct r.reporter_id)::integer into v_count
    from private.reports r
    where r.target_id = p_target and r.kind = 'handle' and r.status = 'open' and r.trusted
      and r.snapshot ->> 'handle_key' = v_key;
    if v_count >= v_settings.auto_hide_reports then
      insert into private.content_holds (target_id, kind, content_key, source)
      values (p_target, 'handle', v_key, 'auto')
      on conflict do nothing;
    end if;
  end if;

  -- Brigade: as many untrusted reporters as auto-hide needs, all on one player, is flagged for the
  -- moderator instead of hiding anything.
  select count(distinct r.reporter_id)::integer into v_count
  from private.reports r
  where r.target_id = p_target and r.status = 'open' and not r.trusted;
  if v_count >= v_settings.auto_hide_reports then
    update private.reports r
    set brigade = true
    where r.target_id = p_target and r.status = 'open' and not r.brigade;
  end if;

  duplicate := false;
  return next;
end;
$$;

-- The caller's own reports: what and when, and whether a moderator has looked. Never the
-- outcome for the other player, the note or the snapshot.
create function public.list_my_reports()
returns table (
  report_id uuid,
  kind text,
  reason text,
  status text,
  target_handle text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
begin
  v_uid := private.require_attestation();
  return query
    select r.id, r.kind, r.reason,
      case when r.status = 'open' then 'open' else 'reviewed' end,
      private.public_handle(r.target_id),
      r.created_at
    from private.reports r
    where r.reporter_id = v_uid
    order by r.created_at desc, r.id
    limit 100;
end;
$$;

create function public.acknowledge_notice(p_notice_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  v_uid := private.require_attestation();
  update public.account_notices n
  set acknowledged_at = coalesce(n.acknowledged_at, now())
  where n.id = p_notice_id and n.user_id = v_uid;
  if not found then
    raise exception 'notice_not_found' using errcode = 'PT404';
  end if;
end;
$$;

-- One appeal per sanction, from the notice about it. Handle resets are not appealable (the
-- player can choose a new handle).
create function public.submit_appeal(p_notice_id uuid, p_body text)
returns table (appeal_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
  v_body text;
  v_sanction private.sanctions;
begin
  v_uid := private.require_attestation();
  v_body := nullif(btrim(p_body), '');
  if v_body is null then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  if char_length(v_body) > (private.moderation_settings()).appeal_max_chars then
    raise exception 'appeal_too_long' using errcode = 'PT400';
  end if;

  select s.* into v_sanction
  from public.account_notices n
  join private.sanctions s on s.id = n.sanction_id
  where n.id = p_notice_id and n.user_id = v_uid and s.user_id = v_uid;
  if not found then
    if exists (
      select 1 from public.account_notices n where n.id = p_notice_id and n.user_id = v_uid
    ) then
      raise exception 'not_appealable' using errcode = 'PT400';
    end if;
    raise exception 'notice_not_found' using errcode = 'PT404';
  end if;
  if v_sanction.kind = 'handle_reset' or v_sanction.revoked_at is not null then
    raise exception 'not_appealable' using errcode = 'PT400';
  end if;

  insert into private.appeals (user_id, sanction_id, body)
  values (v_uid, v_sanction.id, v_body)
  on conflict (sanction_id) do nothing
  returning id into appeal_id;
  if appeal_id is null then
    raise exception 'appeal_exists' using errcode = 'PT409';
  end if;
  return next;
end;
$$;

revoke execute on function public.block_player(uuid) from public, anon;
grant execute on function public.block_player(uuid) to authenticated;
revoke execute on function public.unblock_player(uuid, uuid) from public, anon;
grant execute on function public.unblock_player(uuid, uuid) to authenticated;
revoke execute on function public.mute_player(uuid) from public, anon;
grant execute on function public.mute_player(uuid) to authenticated;
revoke execute on function public.unmute_player(uuid) from public, anon;
grant execute on function public.unmute_player(uuid) to authenticated;
revoke execute on function public.list_my_blocks() from public, anon;
grant execute on function public.list_my_blocks() to authenticated;
revoke execute on function public.list_my_mutes() from public, anon;
grant execute on function public.list_my_mutes() to authenticated;
revoke execute on function public.submit_report(uuid, text, text, text, text) from public, anon;
grant execute on function public.submit_report(uuid, text, text, text, text) to authenticated;
revoke execute on function public.list_my_reports() from public, anon;
grant execute on function public.list_my_reports() to authenticated;
revoke execute on function public.acknowledge_notice(uuid) from public, anon;
grant execute on function public.acknowledge_notice(uuid) to authenticated;
revoke execute on function public.submit_appeal(uuid, text) from public, anon;
grant execute on function public.submit_appeal(uuid, text) to authenticated;

comment on function public.list_my_blocks() is
  '@standing-exempt: reads the caller''s own list';
comment on function public.list_my_mutes() is
  '@standing-exempt: reads the caller''s own list';
comment on function public.submit_report(uuid, text, text, text, text) is
  '@standing-exempt: a sanctioned player must still be able to report abuse';
comment on function public.list_my_reports() is
  '@standing-exempt: reads the caller''s own reports';
comment on function public.acknowledge_notice(uuid) is
  '@standing-exempt: a sanctioned player acknowledges the notice about it';
comment on function public.submit_appeal(uuid, text) is
  '@standing-exempt: appeals exist for sanctioned players';
