-- Shelf Date Tracker database
-- Paste this whole file into Supabase: SQL Editor > New query > Run.
-- Safe to run once on a new project.

-- A store is one team (your store, or a department in it). Everyone in it shares the same data.
create table public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text not null unique default upper(substr(md5(random()::text), 1, 6)),
  markdown_days int not null default 2,
  pull_days int not null default 0,
  timezone text not null default 'America/New_York',
  notify_hour int not null default 6 check (notify_hour between 0 and 23),
  created_at timestamptz not null default now()
);

create table public.members (
  store_id uuid not null references public.stores on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);

create table public.products (
  store_id uuid not null references public.stores on delete cascade,
  upc text not null,
  name text not null,
  category text not null default 'Uncategorized',
  shelf_days int not null default 14,
  last_qty int,
  last_stocked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (store_id, upc)
);

-- A batch is one expiration date of one product on the shelf.
-- events = every time units were put out: [{ "at": <ms timestamp>, "qty": <units> }]
create table public.batches (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  upc text not null,
  exp date not null,
  qty int not null default 0,
  events jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'marked', 'gone', 'pulled')),
  marked_at timestamptz,
  seen_at timestamptz,
  closed_at timestamptz,
  closed_via text,
  alert text,
  predicted text,
  created_at timestamptz not null default now(),
  foreign key (store_id, upc) references public.products (store_id, upc) on delete cascade
);
create index batches_store_status on public.batches (store_id, status);

-- Phones that turned on alerts.
create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  store_id uuid not null references public.stores on delete cascade,
  subscription jsonb not null,
  last_sent_on date,
  created_at timestamptz not null default now()
);

-- ---------- access rules: you only ever see your own store's data ----------
create function public.is_member(s uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from members where store_id = s and user_id = auth.uid())
$$;
create function public.is_owner(s uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from members where store_id = s and user_id = auth.uid() and role = 'owner')
$$;

alter table public.stores enable row level security;
alter table public.members enable row level security;
alter table public.products enable row level security;
alter table public.batches enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "members read their store" on public.stores for select using (public.is_member(id));
create policy "owners change store settings" on public.stores for update using (public.is_owner(id)) with check (public.is_owner(id));

create policy "members see teammates" on public.members for select using (public.is_member(store_id));
create policy "leave a store" on public.members for delete using (user_id = auth.uid());

create policy "members use products" on public.products for all using (public.is_member(store_id)) with check (public.is_member(store_id));
create policy "members use batches" on public.batches for all using (public.is_member(store_id)) with check (public.is_member(store_id));

create policy "own alert subscriptions" on public.push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(store_id));

-- ---------- creating and joining stores ----------
create function public.create_store(p_name text) returns public.stores
language plpgsql security definer set search_path = public as $$
declare s stores;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into stores (name) values (trim(p_name)) returning * into s;
  insert into members (store_id, user_id, role) values (s.id, auth.uid(), 'owner');
  return s;
end $$;

create function public.join_store(p_code text) returns public.stores
language plpgsql security definer set search_path = public as $$
declare s stores;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into s from stores where join_code = upper(trim(p_code));
  if not found then raise exception 'No store has that code. Check it with your manager.'; end if;
  insert into members (store_id, user_id) values (s.id, auth.uid()) on conflict do nothing;
  return s;
end $$;

revoke execute on function public.create_store(text), public.join_store(text) from public, anon;
grant execute on function public.create_store(text), public.join_store(text) to authenticated;

-- Table permissions. Newer Supabase projects don't grant these automatically.
-- Signed-in users get access, but the rules above still limit them to their own store.
-- service_role is the daily alert sender. Signed-out visitors (anon) get nothing.
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.products, public.batches, public.push_subscriptions to authenticated;
grant select, update on public.stores to authenticated;
grant select, delete on public.members to authenticated;
grant all on public.stores, public.members, public.products, public.batches, public.push_subscriptions to service_role;
grant execute on function public.is_member(uuid), public.is_owner(uuid) to authenticated;

-- Live updates: when a coworker logs something, everyone's screen refreshes.
alter publication supabase_realtime add table public.products, public.batches, public.stores;
