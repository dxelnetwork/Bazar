-- =============================================================================
-- Complete Schema Reference: Bazar Manager
-- Stack: Next.js, Supabase, PostgreSQL (Single Source of Truth)
-- Hardened with profile privilege protection, closed month immutability,
-- UUID-keyed settlements, deterministic integer-cent rounding reconciliation,
-- and strict RPC permissions.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Profiles Table
-- -----------------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'member' check (role in ('admin','member')),
  status text not null default 'active' check (status in ('active', 'inactive')),
  whatsapp text,
  created_at timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- 2. Bazar Months Table (Monthly Accounting Cycles)
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 3. Bazar Entries Table
-- -----------------------------------------------------------------------------
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

-- Enable Row Level Security
alter table profiles enable row level security;
alter table bazar_months enable row level security;
alter table bazar_entries enable row level security;

-- Partial unique index: only ONE month can be active at a time
create unique index if not exists idx_one_active_month
on bazar_months (status) where status = 'active';

-- Index for entry lookups by month
create index if not exists idx_entries_month on bazar_entries(month_id);

-- -----------------------------------------------------------------------------
-- 4. Helper Security Functions
-- -----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_month_active(mid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from bazar_months where id = mid and status = 'active');
$$;

create or replace function public.is_active_member(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = uid and status = 'active');
$$;

-- -----------------------------------------------------------------------------
-- 5. Profile Security: Prevent Privilege Escalation
-- -----------------------------------------------------------------------------
create or replace function public.check_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- If the caller is NOT an admin, forbid modifying role, status, or id
  if not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'Privilege escalation denied: Only admin can modify user roles';
    end if;
    if new.status is distinct from old.status then
      raise exception 'Permission denied: Only admin can modify account status';
    end if;
    if new.id is distinct from old.id then
      raise exception 'Permission denied: User ID cannot be altered';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_check_profile_update on profiles;
create trigger trg_check_profile_update
before update on profiles
for each row execute function public.check_profile_update();

drop policy if exists "profiles authenticated read" on profiles;
create policy "profiles authenticated read" on profiles for select
  using (auth.uid() is not null);

drop policy if exists "profiles self or admin update" on profiles;
create policy "profiles self or admin update" on profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- -----------------------------------------------------------------------------
-- 6. Closed Month Immutability: bazar_months
-- -----------------------------------------------------------------------------
create or replace function public.check_closed_month_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1. Once closed, records and settlement snapshots are permanent and cannot be modified
  if old.status = 'closed' then
    raise exception 'Closed month immutability: Closed month records and settlement snapshots are permanent and cannot be modified';
  end if;

  -- 2. Prevent marking a month closed without generating the authoritative settlement snapshot
  if tg_op = 'UPDATE' and new.status = 'closed' then
    if new.settlement_snapshot is null or new.closed_at is null or new.closed_by is null then
      raise exception 'Invalid month closure: Months can only be closed through the close_month() procedure with an authoritative snapshot';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_check_closed_month_immutable on bazar_months;
create trigger trg_check_closed_month_immutable
before update or delete on bazar_months
for each row execute function public.check_closed_month_immutable();

drop policy if exists "months authenticated read" on bazar_months;
create policy "months authenticated read" on bazar_months for select
  using (auth.uid() is not null);

drop policy if exists "months admin insert" on bazar_months;
create policy "months admin insert" on bazar_months for insert
  with check (public.is_admin());

drop policy if exists "months admin update" on bazar_months;
create policy "months admin update" on bazar_months for update
  using (public.is_admin() and status = 'active')
  with check (public.is_admin() and status = 'active');

-- -----------------------------------------------------------------------------
-- 7. Closed Month Immutability: bazar_entries
-- -----------------------------------------------------------------------------
create or replace function public.check_entry_month_active()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if not public.is_month_active(old.month_id) then
      raise exception 'Closed month immutability: Cannot delete entries from a closed month';
    end if;
    return old;
  elsif tg_op = 'UPDATE' then
    if not public.is_month_active(old.month_id) then
      raise exception 'Closed month immutability: Cannot modify entries belonging to a closed month';
    end if;
    if not public.is_month_active(new.month_id) then
      raise exception 'Closed month immutability: Cannot move entries into a closed month';
    end if;
    return new;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_check_entry_month_active on bazar_entries;
create trigger trg_check_entry_month_active
before update or delete on bazar_entries
for each row execute function public.check_entry_month_active();

drop policy if exists "entries authenticated read" on bazar_entries;
create policy "entries authenticated read" on bazar_entries for select
  using (auth.uid() is not null);

drop policy if exists "entries own or admin insert active month" on bazar_entries;
create policy "entries own or admin insert active month" on bazar_entries for insert
  with check (
    (
      (user_id = auth.uid() and public.is_active_member(auth.uid()))
      or public.is_admin()
    )
    and public.is_month_active(month_id)
  );

drop policy if exists "entries admin update" on bazar_entries;
drop policy if exists "entries admin update active month only" on bazar_entries;
create policy "entries admin update active month only" on bazar_entries for update
  using (public.is_admin() and public.is_month_active(month_id))
  with check (public.is_admin() and public.is_month_active(month_id));

drop policy if exists "entries admin delete" on bazar_entries;
drop policy if exists "entries admin delete active month only" on bazar_entries;
create policy "entries admin delete active month only" on bazar_entries for delete
  using (public.is_admin() and public.is_month_active(month_id));

-- Trigger: set updated_at
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

-- -----------------------------------------------------------------------------
-- 8. RPC: close_month (Authoritative Server-Side Settlement)
-- -----------------------------------------------------------------------------
create or replace function public.close_month(
  p_month_id uuid,
  p_settlement_snapshot jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month record;
  v_total numeric(12,2);
  v_total_cents bigint;
  v_members integer;
  v_base_share_cents bigint;
  v_remainder_cents bigint;
  v_share numeric(12,2);

  v_members_json jsonb;
  v_totals_by_id jsonb := '{}'::jsonb;
  v_balances_by_id jsonb := '{}'::jsonb;
  v_entries_json jsonb;
  v_authoritative_snapshot jsonb;

  v_profile record;
  v_idx int := 0;
  v_spent numeric(12,2);
  v_spent_cents bigint;
  v_allocated_share_cents bigint;
  v_bal_cents bigint;
  v_bal numeric(12,2);

  -- Transaction settlement arrays (integer cents, UUID-keyed)
  v_debtor_ids uuid[] := '{}';
  v_debtor_names text[] := '{}';
  v_debtor_cents bigint[] := '{}';

  v_creditor_ids uuid[] := '{}';
  v_creditor_names text[] := '{}';
  v_creditor_cents bigint[] := '{}';

  v_d_idx int := 1;
  v_c_idx int := 1;
  v_tx_cents bigint;
  v_tx_amt numeric(12,2);
  v_tx_json jsonb := '[]'::jsonb;
begin
  -- 1. Admin verification
  if not public.is_admin() then
    raise exception 'Only admin can close a month';
  end if;

  -- 2. Lock and validate month
  select * into v_month from bazar_months where id = p_month_id for update;

  if v_month is null then
    raise exception 'Month not found';
  end if;

  if v_month.status = 'closed' then
    raise exception 'Month is already closed';
  end if;

  -- 3. Count active participating members
  select count(*) into v_members
  from profiles
  where status = 'active';

  -- Reject month closure if no active members exist
  if v_members is null or v_members = 0 then
    raise exception 'Cannot close month: No active members found. At least one active member is required for settlement.';
  end if;

  -- 4. Calculate canonical total expenditure directly from actual database entries
  select round(coalesce(sum(amount), 0), 2) into v_total
  from bazar_entries where month_id = p_month_id;

  -- 5. Calculate canonical equal share and integer cent distribution
  v_total_cents := round(v_total * 100)::bigint;
  v_base_share_cents := v_total_cents / v_members;
  v_remainder_cents := v_total_cents % v_members;
  v_share := round(v_total / v_members, 2);

  -- 6. Build authoritative member list
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'role', p.role
  ) order by p.name), '[]'::jsonb)
  into v_members_json
  from profiles p
  where p.status = 'active';

  -- 7. Calculate member expenditures and balances using integer cents with deterministic cent allocation
  v_idx := 0;
  for v_profile in (
    select
      p.id,
      p.name,
      round(coalesce(spent.total_spent, 0), 2) as total_spent
    from profiles p
    left join (
      select user_id, round(coalesce(sum(amount), 0), 2) as total_spent
      from bazar_entries
      where month_id = p_month_id
      group by user_id
    ) spent on spent.user_id = p.id
    where p.status = 'active'
    order by p.id asc
  ) loop
    v_idx := v_idx + 1;
    v_spent := v_profile.total_spent;
    v_spent_cents := round(v_spent * 100)::bigint;

    -- Deterministically allocate remainder cents to the first v_remainder_cents members ordered by stable UUID
    if v_idx <= v_remainder_cents then
      v_allocated_share_cents := v_base_share_cents + 1;
    else
      v_allocated_share_cents := v_base_share_cents;
    end if;

    v_bal_cents := v_spent_cents - v_allocated_share_cents;
    v_bal := round(v_bal_cents / 100.0, 2);

    -- Store using UUID keys to safely handle duplicate member names
    v_totals_by_id := v_totals_by_id || jsonb_build_object(v_profile.id::text, v_spent);
    v_balances_by_id := v_balances_by_id || jsonb_build_object(v_profile.id::text, v_bal);

    if v_bal_cents < 0 then
      v_debtor_ids := array_append(v_debtor_ids, v_profile.id);
      v_debtor_names := array_append(v_debtor_names, v_profile.name);
      v_debtor_cents := array_append(v_debtor_cents, -v_bal_cents);
    elsif v_bal_cents > 0 then
      v_creditor_ids := array_append(v_creditor_ids, v_profile.id);
      v_creditor_names := array_append(v_creditor_names, v_profile.name);
      v_creditor_cents := array_append(v_creditor_cents, v_bal_cents);
    end if;
  end loop;

  -- 8. Calculate settlement transactions server-side using integer cents
  v_d_idx := 1;
  v_c_idx := 1;
  while v_d_idx <= coalesce(array_length(v_debtor_ids, 1), 0)
    and v_c_idx <= coalesce(array_length(v_creditor_ids, 1), 0) loop
    v_tx_cents := least(v_debtor_cents[v_d_idx], v_creditor_cents[v_c_idx]);
    if v_tx_cents > 0 then
      v_tx_amt := round(v_tx_cents / 100.0, 2);
      v_tx_json := v_tx_json || jsonb_build_array(jsonb_build_object(
        'fromId', v_debtor_ids[v_d_idx],
        'fromName', v_debtor_names[v_d_idx],
        'from', v_debtor_names[v_d_idx],
        'toId', v_creditor_ids[v_c_idx],
        'toName', v_creditor_names[v_c_idx],
        'to', v_creditor_names[v_c_idx],
        'amount', v_tx_amt
      ));
      v_debtor_cents[v_d_idx] := v_debtor_cents[v_d_idx] - v_tx_cents;
      v_creditor_cents[v_c_idx] := v_creditor_cents[v_c_idx] - v_tx_cents;
    end if;
    if v_debtor_cents[v_d_idx] = 0 then
      v_d_idx := v_d_idx + 1;
    end if;
    if v_creditor_cents[v_c_idx] = 0 then
      v_c_idx := v_c_idx + 1;
    end if;
  end loop;

  -- 9. Build authoritative entries list directly from database
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'user_id', e.user_id,
    'person', p.name,
    'bazar_date', e.bazar_date,
    'item', e.item,
    'category', e.category,
    'amount', e.amount,
    'notes', e.notes
  ) order by e.bazar_date desc, e.created_at desc), '[]'::jsonb)
  into v_entries_json
  from bazar_entries e
  join profiles p on p.id = e.user_id
  where e.month_id = p_month_id;

  -- 10. Assemble authoritative snapshot
  v_authoritative_snapshot := jsonb_build_object(
    'totals_by_id', v_totals_by_id,
    'balances_by_id', v_balances_by_id,
    'members', v_members_json,
    'entries', v_entries_json,
    'settlement', jsonb_build_object(
      'total', v_total,
      'share', v_share,
      'balances_by_id', v_balances_by_id,
      'transactions', v_tx_json
    ),
    'closed_at', now(),
    'closed_by', auth.uid()
  );

  -- 11. Atomically store snapshot and close month
  update bazar_months set
    status = 'closed',
    total_amount = v_total,
    total_members = v_members,
    per_person_share = v_share,
    settlement_snapshot = v_authoritative_snapshot,
    closed_by = auth.uid(),
    closed_at = now()
  where id = p_month_id;

  return jsonb_build_object(
    'success', true,
    'total', v_total,
    'members', v_members,
    'share', v_share,
    'snapshot', v_authoritative_snapshot
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. RPC: start_new_month
-- -----------------------------------------------------------------------------
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
  v_overlap_count integer;
  v_new_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admin can start a new month';
  end if;

  if p_start_date > p_end_date then
    raise exception 'start_date (%) must be before or equal to end_date (%)', p_start_date, p_end_date;
  end if;

  select count(*) into v_active_count from bazar_months where status = 'active';
  if v_active_count > 0 then
    raise exception 'An active month already exists. Close it first before starting a new month.';
  end if;

  select count(*) into v_overlap_count
  from bazar_months
  where not (end_date < p_start_date or start_date > p_end_date);

  if v_overlap_count > 0 then
    raise exception 'Date range [% to %] overlaps with an existing monthly period', p_start_date, p_end_date;
  end if;

  insert into bazar_months (month_name, start_date, end_date, status)
  values (p_month_name, p_start_date, p_end_date, 'active')
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Reporting View
-- -----------------------------------------------------------------------------
create or replace view public.bazar_entries_with_people as
select e.id, e.month_id, e.user_id, p.name as person, e.bazar_date, e.item, e.category,
       e.amount, e.notes, e.created_at, e.updated_at
from bazar_entries e
join profiles p on p.id = e.user_id;

-- -----------------------------------------------------------------------------
-- 11. Security Definer RPC Execution Permissions
-- -----------------------------------------------------------------------------
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

revoke all on function public.is_month_active(uuid) from public, anon;
grant execute on function public.is_month_active(uuid) to authenticated;

revoke all on function public.is_active_member(uuid) from public, anon;
grant execute on function public.is_active_member(uuid) to authenticated;

revoke all on function public.close_month(uuid, jsonb) from public, anon;
grant execute on function public.close_month(uuid, jsonb) to authenticated;

revoke all on function public.start_new_month(text, date, date) from public, anon;
grant execute on function public.start_new_month(text, date, date) to authenticated;
