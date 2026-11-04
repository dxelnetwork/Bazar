create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'member' check (role in ('admin','member')),
  whatsapp text,
  created_at timestamptz default now()
);

create table if not exists bazar_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  bazar_date date not null default current_date,
  item text not null,
  category text,
  amount numeric(12,2) not null check (amount >= 0),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table profiles enable row level security;
alter table bazar_entries enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- Authenticated users can see member names and all bazar updates.
drop policy if exists "profiles self or admin read" on profiles;
create policy "profiles authenticated read" on profiles for select
  using (auth.uid() is not null);

drop policy if exists "profiles self or admin update" on profiles;
create policy "profiles self or admin update" on profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- Everyone logged in can read every bazar entry.
drop policy if exists "entries own or admin read" on bazar_entries;
create policy "entries authenticated read" on bazar_entries for select
  using (auth.uid() is not null);

-- Members may create entries only for themselves. Admin may create for anyone.
drop policy if exists "entries own or admin insert" on bazar_entries;
create policy "entries own or admin insert" on bazar_entries for insert
  with check (user_id = auth.uid() or public.is_admin());

-- IMPORTANT: members have NO UPDATE permission. Only admin can edit.
drop policy if exists "entries own or admin update" on bazar_entries;
create policy "entries admin update" on bazar_entries for update
  using (public.is_admin())
  with check (public.is_admin());

-- IMPORTANT: members have NO DELETE permission. Only admin can delete.
drop policy if exists "entries own or admin delete" on bazar_entries;
create policy "entries admin delete" on bazar_entries for delete
  using (public.is_admin());

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bazar_entries_updated_at on bazar_entries;
create trigger bazar_entries_updated_at
before update on bazar_entries
for each row execute function public.set_updated_at();

-- Optional helper view for reporting / Google Sheets style exports.
create or replace view public.bazar_entries_with_people as
select e.id, e.user_id, p.name as person, e.bazar_date, e.item, e.category,
       e.amount, e.notes, e.created_at, e.updated_at
from bazar_entries e
join profiles p on p.id = e.user_id;
