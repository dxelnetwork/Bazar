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
-- 4. Safe & Accurate Backfill Logic for Existing and Historical Entries
--    - Never deletes, truncates, or overwrites existing entries.
--    - Validates no entries have NULL bazar_date.
--    - Accurately groups historical entries by their true calendar month.
--    - Creates closed months for past periods and keeps at most one active month.
--    - Stops with a descriptive error if any date overlap or ambiguity exists.
--    - Enforces NOT NULL only when all entries are guaranteed to be mapped.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_null_date_count INTEGER;
  v_ambiguous_count INTEGER;
  v_remaining_null INTEGER;
  v_has_active_month BOOLEAN;
  v_latest_unassigned_month DATE;
  v_new_month_id UUID;
  v_status TEXT;
  r RECORD;
BEGIN
  -- Check 1: Ensure no entries have NULL bazar_date
  SELECT COUNT(*) INTO v_null_date_count
  FROM bazar_entries
  WHERE bazar_date IS NULL;

  IF v_null_date_count > 0 THEN
    RAISE EXCEPTION 'Cannot backfill: % entries have NULL bazar_date. Please populate valid dates before running migration.', v_null_date_count;
  END IF;

  -- Check 2: Check for ambiguous overlap with multiple existing months
  SELECT COUNT(*) INTO v_ambiguous_count
  FROM bazar_entries e
  WHERE e.month_id IS NULL
    AND (
      SELECT COUNT(*)
      FROM bazar_months m
      WHERE e.bazar_date >= m.start_date AND e.bazar_date <= m.end_date
    ) > 1;

  IF v_ambiguous_count > 0 THEN
    RAISE EXCEPTION 'Ambiguous mapping: % entries match multiple overlapping months in bazar_months. Please resolve overlapping periods manually before running migration.', v_ambiguous_count;
  END IF;

  -- Step A: If months already exist in bazar_months, assign matching entries by exact date range
  IF EXISTS (SELECT 1 FROM bazar_months LIMIT 1) THEN
    UPDATE bazar_entries e
    SET month_id = m.id
    FROM bazar_months m
    WHERE e.month_id IS NULL
      AND e.bazar_date >= m.start_date
      AND e.bazar_date <= m.end_date;
  END IF;

  -- Step B: For any remaining unassigned entries, group them by their actual historical calendar months
  SELECT COUNT(*) INTO v_remaining_null
  FROM bazar_entries
  WHERE month_id IS NULL;

  IF v_remaining_null > 0 THEN
    -- Check if an active month already exists in bazar_months
    SELECT EXISTS(SELECT 1 FROM bazar_months WHERE status = 'active') INTO v_has_active_month;

    -- Find the latest unassigned month start date
    SELECT MAX(date_trunc('month', bazar_date)::DATE) INTO v_latest_unassigned_month
    FROM bazar_entries
    WHERE month_id IS NULL;

    -- Iterate over each distinct calendar month period among unassigned entries
    FOR r IN (
      SELECT DISTINCT
        date_trunc('month', bazar_date)::DATE as m_start,
        (date_trunc('month', bazar_date) + INTERVAL '1 month - 1 day')::DATE as m_end,
        trim(to_char(bazar_date, 'Month YYYY')) as m_name
      FROM bazar_entries
      WHERE month_id IS NULL
      ORDER BY date_trunc('month', bazar_date)::DATE ASC
    ) LOOP
      -- Verify this period does not partially overlap with any existing month
      IF EXISTS (
        SELECT 1 FROM bazar_months m
        WHERE NOT (m.end_date < r.m_start OR m.start_date > r.m_end)
      ) THEN
        RAISE EXCEPTION 'Ambiguous mapping: historical entries for period % (% to %) conflict with an existing month in bazar_months. Please review month date ranges.', r.m_name, r.m_start, r.m_end;
      END IF;

      -- If no active month exists and this is the latest unassigned month, make it 'active';
      -- all other historical months must be 'closed'.
      IF (NOT v_has_active_month) AND (r.m_start = v_latest_unassigned_month) THEN
        v_status := 'active';
        v_has_active_month := TRUE;
      ELSE
        v_status := 'closed';
      END IF;

      -- Insert the accurate monthly cycle
      INSERT INTO bazar_months (month_name, start_date, end_date, status)
      VALUES (r.m_name, r.m_start, r.m_end, v_status)
      RETURNING id INTO v_new_month_id;

      -- Associate only the entries belonging to this exact calendar month
      UPDATE bazar_entries
      SET month_id = v_new_month_id
      WHERE month_id IS NULL
        AND bazar_date >= r.m_start
        AND bazar_date <= r.m_end;
    END LOOP;
  END IF;

  -- Step C: If there are still no months in bazar_months (e.g. fresh database with 0 entries),
  -- create an initial active month for the current calendar month.
  IF NOT EXISTS (SELECT 1 FROM bazar_months LIMIT 1) THEN
    INSERT INTO bazar_months (month_name, start_date, end_date, status)
    VALUES (
      trim(to_char(CURRENT_DATE, 'Month YYYY')),
      date_trunc('month', CURRENT_DATE)::DATE,
      (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::DATE,
      'active'
    );
  END IF;

  -- Step D: Verification check — confirm zero unassigned entries remain
  SELECT COUNT(*) INTO v_remaining_null
  FROM bazar_entries
  WHERE month_id IS NULL;

  IF v_remaining_null > 0 THEN
    RAISE EXCEPTION 'Safety check failed: % entries could not be safely mapped to a monthly cycle. Migration halted to protect existing data.', v_remaining_null;
  END IF;

  -- Step E: Safely enforce NOT NULL on month_id
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
-- 10. RPC: close_month (Authoritative Database Generation)
--     Validates against actual database entries and active profiles.
--     Guarantees totals, member count, share, and snapshot cannot disagree.
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
  v_members_json JSONB;
  v_totals_json JSONB;
  v_entries_json JSONB;
  v_authoritative_snapshot JSONB;
  v_db_spent NUMERIC(12,2);
  v_profile RECORD;
  v_bal_json JSONB := '{}'::JSONB;
  v_tx_json JSONB := '[]'::JSONB;
BEGIN
  -- 1. Admin verification
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admin can close a month';
  END IF;

  -- 2. Lock the month record
  SELECT * INTO v_month FROM bazar_months WHERE id = p_month_id FOR UPDATE;

  IF v_month IS NULL THEN
    RAISE EXCEPTION 'Month not found';
  END IF;

  IF v_month.status = 'closed' THEN
    RAISE EXCEPTION 'Month is already closed';
  END IF;

  -- 3. Calculate canonical total expenditure directly from database entries
  SELECT ROUND(COALESCE(SUM(amount), 0), 2) INTO v_total
  FROM bazar_entries WHERE month_id = p_month_id;

  -- 4. Count active participating members from profiles table
  SELECT COUNT(*) INTO v_members
  FROM profiles
  WHERE status = 'active';

  IF v_members IS NULL OR v_members = 0 THEN
    SELECT COUNT(*) INTO v_members FROM profiles;
  END IF;

  IF v_members IS NULL OR v_members = 0 THEN
    v_members := 1;
  END IF;

  -- 5. Calculate canonical equal share per member
  v_share := ROUND(v_total / v_members, 2);

  -- 6. Build authoritative member list from profiles
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'role', p.role
  ) ORDER BY p.name), '[]'::jsonb)
  INTO v_members_json
  FROM profiles p
  WHERE p.status = 'active';

  -- 7. Build authoritative member-wise expenditure totals from actual database entries
  SELECT COALESCE(jsonb_object_agg(
    p.name,
    COALESCE(spent.total_spent, 0)
  ), '{}'::jsonb)
  INTO v_totals_json
  FROM profiles p
  LEFT JOIN (
    SELECT user_id, ROUND(COALESCE(SUM(amount), 0), 2) as total_spent
    FROM bazar_entries
    WHERE month_id = p_month_id
    GROUP BY user_id
  ) spent ON spent.user_id = p.id
  WHERE p.status = 'active';

  -- 8. Build authoritative entries list directly from database
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'user_id', e.user_id,
    'person', p.name,
    'bazar_date', e.bazar_date,
    'item', e.item,
    'category', e.category,
    'amount', e.amount,
    'notes', e.notes
  ) ORDER BY e.bazar_date DESC, e.created_at DESC), '[]'::jsonb)
  INTO v_entries_json
  FROM bazar_entries e
  JOIN profiles p ON p.id = e.user_id
  WHERE e.month_id = p_month_id;

  -- 9. Calculate individual balances from actual database totals
  FOR v_profile IN (SELECT name FROM profiles WHERE status = 'active' ORDER BY name) LOOP
    v_db_spent := COALESCE((v_totals_json->>v_profile.name)::NUMERIC, 0);
    v_bal_json := v_bal_json || jsonb_build_object(
      v_profile.name,
      ROUND(v_db_spent - v_share, 2)
    );
  END LOOP;

  -- 10. Extract transactions from submitted snapshot if provided
  IF p_settlement_snapshot IS NOT NULL AND (p_settlement_snapshot->'settlement' ? 'transactions') THEN
    v_tx_json := p_settlement_snapshot->'settlement'->'transactions';
  END IF;

  -- 11. Assemble authoritative snapshot
  v_authoritative_snapshot := jsonb_build_object(
    'totals', v_totals_json,
    'members', v_members_json,
    'entries', v_entries_json,
    'settlement', jsonb_build_object(
      'total', v_total,
      'share', v_share,
      'balances', v_bal_json,
      'transactions', v_tx_json
    ),
    'closed_at', NOW(),
    'closed_by', auth.uid()
  );

  -- 12. Save verified values and authoritative snapshot
  UPDATE bazar_months SET
    status = 'closed',
    total_amount = v_total,
    total_members = v_members,
    per_person_share = v_share,
    settlement_snapshot = v_authoritative_snapshot,
    closed_by = auth.uid(),
    closed_at = NOW()
  WHERE id = p_month_id;

  RETURN jsonb_build_object(
    'success', true,
    'total', v_total,
    'members', v_members,
    'share', v_share,
    'snapshot', v_authoritative_snapshot
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. RPC: start_new_month
--     Enforces:
--       - Admin caller
--       - start_date <= end_date
--       - No overlapping month date ranges
--       - Single active month constraint
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
  v_overlap_count INTEGER;
  v_new_id UUID;
BEGIN
  -- 1. Admin verification
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admin can start a new month';
  END IF;

  -- 2. Validate start_date <= end_date
  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'start_date (%) must be before or equal to end_date (%)', p_start_date, p_end_date;
  END IF;

  -- 3. Check no active month exists
  SELECT COUNT(*) INTO v_active_count FROM bazar_months WHERE status = 'active';
  IF v_active_count > 0 THEN
    RAISE EXCEPTION 'An active month already exists. Close it first before starting a new month.';
  END IF;

  -- 4. Prevent overlapping month date ranges
  SELECT COUNT(*) INTO v_overlap_count
  FROM bazar_months
  WHERE NOT (end_date < p_start_date OR start_date > p_end_date);

  IF v_overlap_count > 0 THEN
    RAISE EXCEPTION 'Date range [% to %] overlaps with an existing monthly period', p_start_date, p_end_date;
  END IF;

  -- 5. Create new active month
  INSERT INTO bazar_months (month_name, start_date, end_date, status)
  VALUES (p_month_name, p_start_date, p_end_date, 'active')
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;
