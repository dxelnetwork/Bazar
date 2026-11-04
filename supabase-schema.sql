-- =============================================================================
-- Bazar App – Complete Schema Reference
-- Last updated: 2026-11-04 (after 001_monthly_cycles migration)
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'member' check (role in ('admin','member')),
  whatsapp text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz default now()
);

create table if not exists bazar_months (
  id uuid primary key default gen_random_uuid(),
  month_name text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'active' check (status in ('active', 'closed')),
  total_amount numeric(12,2) default 0,
  total_members integer default 0,
  per_person_share numeric(12,2) default 0,
  settlement_snapshot jsonb,
  closed_by uuid references auth.users(id),
  closed_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists bazar_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  month_id uuid not null references bazar_months(id),
  bazar_date date not null default current_date,
  item text not null,
  category text,
  amount numeric(12,2) not null check (amount >= 0),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Only ONE month can have status='active' at a time
create unique index if not exists idx_one_active_month
on bazar_months (status) where status = 'active';

-- Fast lookups by month
create index if not exists idx_entries_month on bazar_entries(month_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table profiles enable row level security;
alter table bazar_entries enable row level security;
alter table bazar_months enable row level security;

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_month_active(mid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from bazar_months where id = mid and status = 'active');
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

drop trigger if exists bazar_entries_updated_at on bazar_entries;
create trigger bazar_entries_updated_at
before update on bazar_entries
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Policies: profiles
-- ---------------------------------------------------------------------------

drop policy if exists "profiles self or admin read" on profiles;
create policy "profiles authenticated read" on profiles for select
  using (auth.uid() is not null);

drop policy if exists "profiles self or admin update" on profiles;
create policy "profiles self or admin update" on profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- Policies: bazar_entries
-- ---------------------------------------------------------------------------

drop policy if exists "entries own or admin read" on bazar_entries;
create policy "entries authenticated read" on bazar_entries for select
  using (auth.uid() is not null);

-- Insert requires own user or admin AND the target month must be active
drop policy if exists "entries own or admin insert" on bazar_entries;
drop policy if exists "entries authenticated insert" on bazar_entries;
drop policy if exists "entries own or admin insert active month" on bazar_entries;
create policy "entries own or admin insert active month" on bazar_entries for insert
  with check (
    (user_id = auth.uid() or public.is_admin())
    and public.is_month_active(month_id)
  );

-- Only admin can update entries
drop policy if exists "entries own or admin update" on bazar_entries;
create policy "entries admin update" on bazar_entries for update
  using (public.is_admin())
  with check (public.is_admin());

-- Only admin can delete entries
drop policy if exists "entries own or admin delete" on bazar_entries;
create policy "entries admin delete" on bazar_entries for delete
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Policies: bazar_months
-- ---------------------------------------------------------------------------

drop policy if exists "months authenticated read" on bazar_months;
create policy "months authenticated read" on bazar_months for select
  using (auth.uid() is not null);

drop policy if exists "months admin insert" on bazar_months;
create policy "months admin insert" on bazar_months for insert
  with check (public.is_admin());

drop policy if exists "months admin update" on bazar_months;
create policy "months admin update" on bazar_months for update
  using (public.is_admin())
  with check (public.is_admin());

-- No DELETE policy on bazar_months (nobody can delete months)

-- ---------------------------------------------------------------------------
-- RPC: close_month
-- ---------------------------------------------------------------------------

create or replace function public.close_month(
  p_month_id uuid,
  p_settlement_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month record;
  v_total numeric(12,2);
  v_members integer;
  v_share numeric(12,2);
begin
  -- Verify caller is admin
  if not public.is_admin() then
    raise exception 'Only admin can close a month';
  end if;

  -- Get and lock the month
  select * into v_month from bazar_months where id = p_month_id for update;

  if v_month is null then
    raise exception 'Month not found';
  end if;

  if v_month.status = 'closed' then
    raise exception 'Month is already closed';
  end if;

  -- Calculate totals
  select coalesce(sum(amount), 0) into v_total
  from bazar_entries where month_id = p_month_id;

  -- Count distinct members who participated
  select count(distinct user_id) into v_members
  from bazar_entries where month_id = p_month_id;

  -- Avoid division by zero
  if v_members = 0 then
    v_members := 1;
  end if;

  v_share := round(v_total / v_members, 2);

  -- Update the month
  update bazar_months set
    status = 'closed',
    total_amount = v_total,
    total_members = v_members,
    per_person_share = v_share,
    settlement_snapshot = p_settlement_snapshot,
    closed_by = auth.uid(),
    closed_at = now()
  where id = p_month_id;

  return jsonb_build_object(
    'success', true,
    'total', v_total,
    'members', v_members,
    'share', v_share
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: start_new_month
-- ---------------------------------------------------------------------------

create or replace function public.start_new_month(
  p_month_name text,
  p_start_date date,
  p_end_date date
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active_count integer;
  v_new_id uuid;
begin
  -- Verify caller is admin
  if not public.is_admin() then
    raise exception 'Only admin can start a new month';
  end if;

  -- Check no active month exists
  select count(*) into v_active_count from bazar_months where status = 'active';
  if v_active_count > 0 then
    raise exception 'An active month already exists. Close it first.';
  end if;

  -- Create new month
  insert into bazar_months (month_name, start_date, end_date, status)
  values (p_month_name, p_start_date, p_end_date, 'active')
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- View: bazar_entries_with_people (reporting helper)
-- ---------------------------------------------------------------------------

create or replace view public.bazar_entries_with_people as
select e.id, e.user_id, p.name as person, e.month_id, e.bazar_date, e.item,
       e.category, e.amount, e.notes, e.created_at, e.updated_at
from bazar_entries e
join profiles p on p.id = e.user_id;
