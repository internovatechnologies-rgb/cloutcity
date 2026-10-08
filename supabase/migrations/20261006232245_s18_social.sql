-- S18 social tables: friendships, friend boosts, roommates, referrals.
--
-- Clients only read rows they are a party to; every write goes through a security-definer RPC
-- (S20, S21, S22 add them) or the service role. The one RPC here is the daily friend boost.

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendships_not_self check (requester_id <> addressee_id)
);

-- One friendship per pair, whoever asked first.
create unique index friendships_pair_key on public.friendships (
  least(requester_id, addressee_id),
  greatest(requester_id, addressee_id)
);
create index friendships_requester_id_idx on public.friendships (requester_id);
create index friendships_addressee_id_idx on public.friendships (addressee_id);

create trigger friendships_touch_updated_at
  before update on public.friendships
  for each row execute function private.touch_updated_at();

create table public.friend_boosts (
  id bigint generated always as identity primary key,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  -- The New York calendar day the boost was sent on (city time).
  ny_day date not null,
  -- The reward grant, once S20 issues it (foreign key added with public.grants).
  grant_id uuid,
  created_at timestamptz not null default now(),
  constraint friend_boosts_not_self check (sender_id <> recipient_id),
  -- One boost per sender per New York day: the database enforces it, not the client.
  constraint friend_boosts_one_per_sender_per_day unique (sender_id, ny_day)
);

create index friend_boosts_recipient_day_idx on public.friend_boosts (recipient_id, ny_day);

create table public.roommates (
  id uuid primary key default gen_random_uuid(),
  user_low uuid not null references public.profiles (id) on delete cascade,
  user_high uuid not null references public.profiles (id) on delete cascade,
  home_id text not null check (home_id <> ''),
  status text not null default 'pending' check (status in ('pending', 'active', 'ended')),
  invited_by uuid not null,
  accepted_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint roommates_ordered_pair check (user_low < user_high),
  constraint roommates_invited_by_party check (invited_by in (user_low, user_high))
);

-- One active roommate link per player. These indexes cover each column separately: a player
-- who is user_low in one active row and user_high in another is not caught here, so S21's RPC
-- must lock both players' rows before activating a link.
create unique index roommates_one_active_low on public.roommates (user_low)
  where status = 'active';
create unique index roommates_one_active_high on public.roommates (user_high)
  where status = 'active';
create index roommates_user_low_idx on public.roommates (user_low);
create index roommates_user_high_idx on public.roommates (user_high);

create trigger roommates_touch_updated_at
  before update on public.roommates
  for each row execute function private.touch_updated_at();

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references public.profiles (id) on delete cascade,
  invitee_id uuid not null unique references public.profiles (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'qualified', 'rewarded', 'rejected')),
  qualified_at timestamptz,
  rewarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referrals_not_self check (inviter_id <> invitee_id)
);

create index referrals_inviter_id_idx on public.referrals (inviter_id);

create trigger referrals_touch_updated_at
  before update on public.referrals
  for each row execute function private.touch_updated_at();

-- Read access: parties only. No insert, update or delete policies (or grants) for clients.
alter table public.friendships enable row level security;
alter table public.friend_boosts enable row level security;
alter table public.roommates enable row level security;
alter table public.referrals enable row level security;

revoke all on table public.friendships, public.friend_boosts, public.roommates, public.referrals
  from anon, authenticated;
grant select on table public.friendships, public.friend_boosts, public.roommates, public.referrals
  to authenticated;

create policy friendships_select_party on public.friendships
  for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

create policy friend_boosts_select_party on public.friend_boosts
  for select to authenticated
  using ((select auth.uid()) in (sender_id, recipient_id));

create policy roommates_select_party on public.roommates
  for select to authenticated
  using ((select auth.uid()) in (user_low, user_high));

create policy referrals_select_party on public.referrals
  for select to authenticated
  using ((select auth.uid()) in (inviter_id, invitee_id));

-- Accepted friends, whichever of the two asked.
create function private.are_friends(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.friendships f
    where f.status = 'accepted'
      and least(f.requester_id, f.addressee_id) = least(p_a, p_b)
      and greatest(f.requester_id, f.addressee_id) = greatest(p_a, p_b)
  );
$$;

revoke execute on function private.are_friends(uuid, uuid) from public, anon, authenticated;

-- One friend boost per sender per New York day, to an attested, accepted friend. The unique
-- constraint makes concurrent calls safe: exactly one insert wins.
create function public.send_friend_boost(p_to uuid)
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
  if p_to is null or p_to = v_uid then
    raise exception 'invalid_target' using errcode = 'PT400';
  end if;
  -- Unknown and unattested players get the same answer, so the RPC reveals nothing about them.
  if not exists (select 1 from public.profiles p where p.id = p_to and p.attested) then
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

revoke execute on function public.send_friend_boost(uuid) from public, anon;
grant execute on function public.send_friend_boost(uuid) to authenticated;
