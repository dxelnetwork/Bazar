-- =============================================================================
-- Migration: 001_monthly_cycles.sql
-- Purpose:   Add monthly bazar cycle management (bazar_months table, close/start
--            month RPCs, updated RLS policies, profile status column)
-- Safe to run on production databases with existing data. Non-destructive & idempotent.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Create bazar_months table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bazar_months (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month_name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  total_amount NUMERIC(12,2) DEFAULT 0,
  total_members INTEGER DEFAULT 0,
  per_person_share NUMERIC(12,2) DEFAULT 0,
  settlement_snapshot JSONB,
  closed_by UUID REFERENCES auth.users(id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 2. Add status column to profiles if not present
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'status'
  ) THEN
    ALTER TABLE profiles
      ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'inactive'));
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Add month_id column to bazar_entries (nullable initially for safe backfill)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'bazar_entries'
      AND column_name = 'month_id'
  ) THEN
    ALTER TABLE bazar_entries ADD COLUMN month_id UUID REFERENCES bazar_months(id);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Safe Backfill Logic for Existing and NULL entries
--    - Never deletes or overwrites existing data
--    - Matches entries to existing months by date range first
--    - Dynamically calculates the reference month from data / CURRENT_DATE
--    - Ensures an active month exists and associates any orphaned entries
--    - Enforces NOT NULL only once all entries are guaranteed to have a month_id
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_ref_date DATE;
  v_start_date DATE;
  v_end_date DATE;
  v_month_name TEXT;
  v_target_month_id UUID;
  v_null_count INTEGER;
BEGIN
  -- Step A: If months already exist, match unassigned entries by date range
  IF EXISTS (SELECT 1 FROM bazar_months LIMIT 1) THEN
    UPDATE bazar_entries e
    SET month_id = m.id
    FROM bazar_months m
    WHERE e.month_id IS NULL
      AND e.bazar_date >= m.start_date
      AND e.bazar_date <= m.end_date;
  END IF;

  -- Step B: Check if any entries still have month_id IS NULL
  SELECT COUNT(*) INTO v_null_count
  FROM bazar_entries
  WHERE month_id IS NULL;

  -- If there are NULL entries OR no months exist at all, resolve or create the initial/active month
  IF v_null_count > 0 OR NOT EXISTS (SELECT 1 FROM bazar_months LIMIT 1) THEN

    -- Look for an existing active month first
    SELECT id INTO v_target_month_id
    FROM bazar_months
    WHERE status = 'active'
    ORDER BY created_at DESC
    LIMIT 1;

    -- If no active month exists, determine a safe month dynamically
    IF v_target_month_id IS NULL THEN
      -- Pick reference date from latest existing entry, or current date if no entries
      SELECT COALESCE(MAX(bazar_date), CURRENT_DATE) INTO v_ref_date
      FROM bazar_entries;

      IF v_ref_date IS NULL THEN
        v_ref_date := CURRENT_DATE;
      END IF;

      v_start_date := date_trunc('month', v_ref_date)::DATE;
      v_end_date := (date_trunc('month', v_ref_date) + INTERVAL '1 month - 1 day')::DATE;
      v_month_name := trim(to_char(v_ref_date, 'Month YYYY'));

      -- Check if this specific month already exists as closed
      SELECT id INTO v_target_month_id
      FROM bazar_months
      WHERE start_date = v_start_date AND end_date = v_end_date
      LIMIT 1;

      -- If it doesn't exist, create it as the active month
      IF v_target_month_id IS NULL THEN
        INSERT INTO bazar_months (month_name, start_date, end_date, status)
        VALUES (v_month_name, v_start_date, v_end_date, 'active')
        RETURNING id INTO v_target_month_id;
      END IF;
    END IF;

    -- Step C: Assign any remaining NULL entries to the target month
    IF v_target_month_id IS NOT NULL THEN
      UPDATE bazar_entries
      SET month_id = v_target_month_id
      WHERE month_id IS NULL;
    END IF;

  END IF;

  -- Step D: Safely enforce NOT NULL on month_id only if 0 NULL rows remain
  IF NOT EXISTS (SELECT 1 FROM bazar_entries WHERE month_id IS NULL) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'bazar_entries'
        AND column_name = 'month_id'
        AND is_nullable = 'YES'
    ) THEN
      ALTER TABLE bazar_entries ALTER COLUMN month_id SET NOT NULL;
    END IF;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Unique constraint: only ONE month can have status='active' at a time
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_month
ON bazar_months (status) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 6. Index on bazar_entries.month_id for fast lookups
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_entries_month ON bazar_entries(month_id);

-- ---------------------------------------------------------------------------
-- 7. RLS for bazar_months
-- ---------------------------------------------------------------------------
ALTER TABLE bazar_months ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read months
DROP POLICY IF EXISTS "months authenticated read" ON bazar_months;
CREATE POLICY "months authenticated read" ON bazar_months FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only admin can create new months
DROP POLICY IF EXISTS "months admin insert" ON bazar_months;
CREATE POLICY "months admin insert" ON bazar_months FOR INSERT
  WITH CHECK (public.is_admin());

-- Only admin can update (close) months
DROP POLICY IF EXISTS "months admin update" ON bazar_months;
CREATE POLICY "months admin update" ON bazar_months FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ---------------------------------------------------------------------------
-- 8. Helper function: check if a month is active
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_month_active(mid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(SELECT 1 FROM bazar_months WHERE id = mid AND status = 'active');
$$;

-- ---------------------------------------------------------------------------
-- 9. Update bazar_entries INSERT policy to enforce active-month check
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "entries own or admin insert" ON bazar_entries;
DROP POLICY IF EXISTS "entries authenticated insert" ON bazar_entries;
DROP POLICY IF EXISTS "entries own or admin insert active month" ON bazar_entries;

CREATE POLICY "entries own or admin insert active month" ON bazar_entries FOR INSERT
  WITH CHECK (
    (user_id = auth.uid() OR public.is_admin())
    AND public.is_month_active(month_id)
  );

-- ---------------------------------------------------------------------------
-- 10. RPC: close_month (Consistent calculation with dashboard settlement)
--     Counts all active members (including those with 0 spending).
--     Stored totals, member count, per-person share, and snapshot agree.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_month(
  p_month_id UUID,
  p_settlement_snapshot JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month RECORD;
  v_total NUMERIC(12,2);
  v_members INTEGER;
  v_share NUMERIC(12,2);
BEGIN
  -- Verify caller is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admin can close a month';
  END IF;

  -- Lock the month record
  SELECT * INTO v_month FROM bazar_months WHERE id = p_month_id FOR UPDATE;

  IF v_month IS NULL THEN
    RAISE EXCEPTION 'Month not found';
  END IF;

  IF v_month.status = 'closed' THEN
    RAISE EXCEPTION 'Month is already closed';
  END IF;

  -- 1. Calculate actual monthly total expenditure
  SELECT ROUND(COALESCE(SUM(amount), 0), 2) INTO v_total
  FROM bazar_entries WHERE month_id = p_month_id;

  -- 2. Count active participating members
  --    In shared-bazar accounting, expenses are split among all active household members,
  --    including members with zero spending for the month.
  SELECT COUNT(*) INTO v_members
  FROM profiles
  WHERE status = 'active';

  -- Fallbacks if profiles table has no rows or status column not yet marked
  IF v_members IS NULL OR v_members = 0 THEN
    SELECT COUNT(*) INTO v_members FROM profiles;
  END IF;

  -- If snapshot provides a validated member list, respect that count
  IF (v_members IS NULL OR v_members = 0) AND p_settlement_snapshot IS NOT NULL THEN
    IF p_settlement_snapshot ? 'members' AND jsonb_array_length(p_settlement_snapshot->'members') > 0 THEN
      v_members := jsonb_array_length(p_settlement_snapshot->'members');
    END IF;
  END IF;

  -- Ensure divisor is at least 1
  IF v_members IS NULL OR v_members = 0 THEN
    v_members := 1;
  END IF;

  -- 3. Calculate equal share per active member
  v_share := ROUND(v_total / v_members, 2);

  -- 4. Save permanent immutable snapshot and close month
  UPDATE bazar_months SET
    status = 'closed',
    total_amount = v_total,
    total_members = v_members,
    per_person_share = v_share,
    settlement_snapshot = p_settlement_snapshot,
    closed_by = auth.uid(),
    closed_at = NOW()
  WHERE id = p_month_id;

  RETURN jsonb_build_object(
    'success', true,
    'total', v_total,
    'members', v_members,
    'share', v_share
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. RPC: start_new_month
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_new_month(
  p_month_name TEXT,
  p_start_date DATE,
  p_end_date DATE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_count INTEGER;
  v_new_id UUID;
BEGIN
  -- Verify caller is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admin can start a new month';
  END IF;

  -- Check no active month exists
  SELECT COUNT(*) INTO v_active_count FROM bazar_months WHERE status = 'active';
  IF v_active_count > 0 THEN
    RAISE EXCEPTION 'An active month already exists. Close it first.';
  END IF;

  -- Create new month
  INSERT INTO bazar_months (month_name, start_date, end_date, status)
  VALUES (p_month_name, p_start_date, p_end_date, 'active')
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;
