-- =============================================================================
-- Migration: 001_monthly_cycles.sql
-- Purpose:   Add monthly bazar cycle management (bazar_months table, close/start
--            month RPCs, updated RLS policies, profile status column)
-- Safe to run on production databases with existing data.
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
-- 2. Add month_id column to bazar_entries (nullable initially for backfill)
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
-- 3. Create initial month & backfill existing entries
--    Only runs if no months exist yet (idempotent).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_month_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bazar_months LIMIT 1) THEN
    INSERT INTO bazar_months (month_name, start_date, end_date, status)
    VALUES ('November 2026', '2026-11-01'::DATE, '2026-11-30'::DATE, 'active')
    RETURNING id INTO v_month_id;

    UPDATE bazar_entries
    SET month_id = v_month_id
    WHERE month_id IS NULL;
  END IF;
END;
$$;

-- After backfill, enforce NOT NULL on month_id
-- (Use DO block to make it idempotent – skip if already NOT NULL)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'bazar_entries'
      AND column_name = 'month_id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE bazar_entries ALTER COLUMN month_id SET NOT NULL;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Unique constraint: only ONE month can have status='active' at a time
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_month
ON bazar_months (status) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 5. Index on bazar_entries.month_id for fast lookups
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_entries_month ON bazar_entries(month_id);

-- ---------------------------------------------------------------------------
-- 6. RLS for bazar_months
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

-- No DELETE policy → nobody can delete months

-- ---------------------------------------------------------------------------
-- 7. Helper function: check if a month is active
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
-- 8. Update bazar_entries INSERT policy to enforce active-month check
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
-- 9. Add status column to profiles
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
-- 10. RPC: close_month
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

  -- Get and lock the month
  SELECT * INTO v_month FROM bazar_months WHERE id = p_month_id FOR UPDATE;

  IF v_month IS NULL THEN
    RAISE EXCEPTION 'Month not found';
  END IF;

  IF v_month.status = 'closed' THEN
    RAISE EXCEPTION 'Month is already closed';
  END IF;

  -- Calculate totals
  SELECT COALESCE(SUM(amount), 0) INTO v_total
  FROM bazar_entries WHERE month_id = p_month_id;

  -- Count distinct active members who participated
  SELECT COUNT(DISTINCT user_id) INTO v_members
  FROM bazar_entries WHERE month_id = p_month_id;

  -- If no members participated, use 1 to avoid division by zero
  IF v_members = 0 THEN
    v_members := 1;
  END IF;

  v_share := ROUND(v_total / v_members, 2);

  -- Update the month
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
