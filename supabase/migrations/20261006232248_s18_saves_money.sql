-- S18 saves, live stats and the money tables (purchases, grants, entitlements).
--
-- Purchases, grants and entitlements are readable only by their owner and writable only by the
-- service role (Stripe webhooks and the one grant function, server-side). Clients have SELECT
-- and nothing else; there are no client write policies.

create table public.saves (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  save_version integer not null check (save_version > 0),
  revision bigint not null default 0 check (revision >= 0),
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 262144),
  client_saved_at timestamptz,
  -- Set by save plausibility checks (S18c).
  flagged_at timestamptz,
  flag_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger saves_touch_updated_at
  before update on public.saves
  for each row execute function private.touch_updated_at();

-- Honest shared numbers (CLAUDE.md principle 5): written only by server code from real data.
create table public.live_stats (
  key text primary key
    check (key in ('players_online', 'players_total', 'visits_today', 'visits_all_time')),
  value bigint not null default 0 check (value >= 0),
  updated_at timestamptz not null default now()
);

create trigger live_stats_touch_updated_at
  before update on public.live_stats
  for each row execute function private.touch_updated_at();

insert into public.live_stats (key)
values ('players_online'), ('players_total'), ('visits_today'), ('visits_all_time')
on conflict (key) do nothing;

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  -- Kept (unlinked) when the account is deleted: payment records outlive the profile.
  user_id uuid references public.profiles (id) on delete set null,
  item_id text not null,
  price_tier text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'usd' check (currency = 'usd'),
  stripe_checkout_session_id text not null unique,
  stripe_payment_intent_id text unique,
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded', 'failed')),
  -- Stripe runs in test mode only (CLAUDE.md "Stack"): a live-mode payment is refused outright.
  livemode boolean not null default false check (livemode = false),
  paid_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index purchases_user_id_idx on public.purchases (user_id);

create trigger purchases_touch_updated_at
  before update on public.purchases
  for each row execute function private.touch_updated_at();

-- ECON-1: every goal, referral, boost and compensation reward is one idempotent, audited,
-- capped grant row. Rows are append-only.
create table public.grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null
    check (kind in ('goal_reward', 'referral_reward', 'boost_reward', 'compensation')),
  idempotency_key text not null unique,
  cash_amount integer not null default 0 check (cash_amount >= 0),
  clout_amount integer not null default 0 check (clout_amount >= 0),
  item_id text,
  cap_amount integer not null check (cap_amount >= 0),
  eligibility jsonb not null,
  reason text not null check (reason <> ''),
  -- 'system' or an operator's user id: never an email.
  issued_by text not null check (
    issued_by = 'system'
    or issued_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  campaign_id text,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  constraint grants_cash_within_cap check (cash_amount <= cap_amount)
);

create index grants_user_id_idx on public.grants (user_id);

-- The only change a grant ever takes is being marked applied, once. Deletes stay possible so
-- deleting an account cascades.
create function private.grants_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'applied_at') is distinct from (to_jsonb(old) - 'applied_at')
    or (old.applied_at is not null and new.applied_at is distinct from old.applied_at) then
    raise exception 'grants_append_only' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function private.grants_append_only() from public, anon, authenticated;

create trigger grants_append_only
  before update on public.grants
  for each row execute function private.grants_append_only();

alter table public.friend_boosts
  add constraint friend_boosts_grant_id_fkey
  foreign key (grant_id) references public.grants (id) on delete set null;

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  item_id text not null,
  source text not null check (source in ('purchase', 'grant')),
  purchase_id uuid references public.purchases (id),
  grant_id uuid references public.grants (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint entitlements_source_link check (
    (source = 'purchase' and purchase_id is not null and grant_id is null)
    or (source = 'grant' and grant_id is not null and purchase_id is null)
  ),
  constraint entitlements_revoke_pair check ((revoked_at is null) = (revoke_reason is null))
);

-- One live entitlement per item per player; a revoked one can be granted again.
create unique index entitlements_one_active on public.entitlements (user_id, item_id)
  where revoked_at is null;
create index entitlements_user_id_idx on public.entitlements (user_id);

create trigger entitlements_touch_updated_at
  before update on public.entitlements
  for each row execute function private.touch_updated_at();

alter table public.saves enable row level security;
alter table public.live_stats enable row level security;
alter table public.purchases enable row level security;
alter table public.grants enable row level security;
alter table public.entitlements enable row level security;

revoke all on table public.saves, public.live_stats, public.purchases, public.grants,
  public.entitlements from anon, authenticated;
grant select on table public.saves, public.live_stats, public.purchases, public.grants,
  public.entitlements to authenticated;
grant select on table public.live_stats to anon;

create policy saves_select_own on public.saves
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy live_stats_select_all on public.live_stats
  for select to anon, authenticated
  using (true);

create policy purchases_select_own on public.purchases
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy grants_select_own on public.grants
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy entitlements_select_own on public.entitlements
  for select to authenticated
  using (user_id = (select auth.uid()));
