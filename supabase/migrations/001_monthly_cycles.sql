-- =============================================================================
-- Migration: 001_monthly_cycles.sql
-- Purpose:   Monthly bazar cycle management with Supabase as single source of truth
--            (bazar_months table, close/start month RPCs, RLS policies, active
--            member restrictions, server-side authoritative settlement snapshots)
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
--    - Validates existing non-NULL month_id references and date ranges.
--    - Never silently rewrites historical associations.
--    - Accurately groups historical entries by their true calendar month.
--    - Creates closed months for past periods and keeps at most one active month.
--    - Stops with a descriptive error if any date overlap or ambiguity exists.
--    - Enforces NOT NULL only when all entries are guaranteed to be mapped.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_null_date_count INTEGER;
  v_invalid_fk_count INTEGER;
  v_out_of_range_count INTEGER;
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

  -- Check 2: Inspect existing non-NULL month_id values for invalid foreign key references
  SELECT COUNT(*) INTO v_invalid_fk_count
  FROM bazar_entries e
  WHERE e.month_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM bazar_months m WHERE m.id = e.month_id);

  IF v_invalid_fk_count > 0 THEN
    RAISE EXCEPTION 'Cannot migrate: % entries have non-NULL month_id referencing non-existent months. Please resolve invalid references before running migration.', v_invalid_fk_count;
  END IF;

  -- Check 3: Inspect existing non-NULL month_id values for dates outside assigned month range
  SELECT COUNT(*) INTO v_out_of_range_count
  FROM bazar_entries e
  JOIN bazar_months m ON m.id = e.month_id
  WHERE e.month_id IS NOT NULL
    AND (e.bazar_date < m.start_date OR e.bazar_date > m.end_date);

  IF v_out_of_range_count > 0 THEN
    RAISE EXCEPTION 'Cannot migrate: % entries with existing month_id have bazar_date outside their assigned month date range. Please resolve mismatched dates manually; historical associations will not be silently rewritten.', v_out_of_range_count;
  END IF;

  -- Check 4: Check for ambiguous overlap with multiple existing months for unassigned entries
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
-- 7. Helper security functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin');
$$;

CREATE OR REPLACE FUNCTION public.is_month_active(mid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(SELECT 1 FROM bazar_months WHERE id = mid AND status = 'active');
$$;

CREATE OR REPLACE FUNCTION public.is_active_member(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = uid AND status = 'active');
$$;

-- ---------------------------------------------------------------------------
-- 8. RLS Policies: bazar_months
--    - Everyone logged in can read monthly periods
--    - Only admin can create new months
--    - Only admin can update months, and only active months can be modified
-- ---------------------------------------------------------------------------
ALTER TABLE bazar_months ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "months authenticated read" ON bazar_months;
CREATE POLICY "months authenticated read" ON bazar_months FOR SELECT
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "months admin insert" ON bazar_months;
CREATE POLICY "months admin insert" ON bazar_months FOR INSERT
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "months admin update" ON bazar_months;
CREATE POLICY "months admin update" ON bazar_months FOR UPDATE
  USING (public.is_admin() AND status = 'active')
  WITH CHECK (public.is_admin());

-- ---------------------------------------------------------------------------
-- 9. Update bazar_entries RLS Policies
--    - Members can insert only for themselves, only in active months, and only if active
--    - Inactive members cannot submit entries
--    - Members cannot edit or delete submitted entries
--    - Admin can manage any entry
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "entries own or admin insert" ON bazar_entries;
DROP POLICY IF EXISTS "entries authenticated insert" ON bazar_entries;
DROP POLICY IF EXISTS "entries own or admin insert active month" ON bazar_entries;

CREATE POLICY "entries own or admin insert active month" ON bazar_entries FOR INSERT
  WITH CHECK (
    (
      (user_id = auth.uid() AND public.is_active_member(auth.uid()))
      OR public.is_admin()
    )
    AND public.is_month_active(month_id)
  );

-- ---------------------------------------------------------------------------
-- 10. RPC: close_month (Pure Server-Side Authoritative Snapshot)
--     - Computes monthly total, active member count, and equal share in SQL
--     - Calculates balances and settlement transactions entirely server-side
--     - Never depends on client-provided calculations or settlement transactions
--     - Saves permanent immutable snapshot and marks month as closed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_month(
  p_month_id UUID,
  p_settlement_snapshot JSONB DEFAULT NULL
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

  -- Settlement calculation arrays
  v_debtor_names TEXT[] := '{}';
  v_debtor_amts NUMERIC[] := '{}';
  v_creditor_names TEXT[] := '{}';
  v_creditor_amts NUMERIC[] := '{}';
  v_d_idx INT := 1;
  v_c_idx INT := 1;
  v_tx_amt NUMERIC(12,2);
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

  -- 9. Calculate individual balances directly from database totals
  FOR v_profile IN (SELECT name FROM profiles WHERE status = 'active' ORDER BY name) LOOP
    v_db_spent := COALESCE((v_totals_json->>v_profile.name)::NUMERIC, 0);
    v_bal_json := v_bal_json || jsonb_build_object(
      v_profile.name,
      ROUND(v_db_spent - v_share, 2)
    );
  END LOOP;

  -- 10. Calculate settlement transactions entirely server-side in PostgreSQL
  FOR v_profile IN (
    SELECT p.name, ROUND(COALESCE(spent.total_spent, 0) - v_share, 2) AS bal
    FROM profiles p
    LEFT JOIN (
      SELECT user_id, ROUND(COALESCE(SUM(amount), 0), 2) AS total_spent
      FROM bazar_entries
      WHERE month_id = p_month_id
      GROUP BY user_id
    ) spent ON spent.user_id = p.id
    WHERE p.status = 'active'
    ORDER BY bal ASC
  ) LOOP
    IF v_profile.bal < -0.001 THEN
      v_debtor_names := array_append(v_debtor_names, v_profile.name);
      v_debtor_amts := array_append(v_debtor_amts, -v_profile.bal);
    ELSIF v_profile.bal > 0.001 THEN
      v_creditor_names := array_append(v_creditor_names, v_profile.name);
      v_creditor_amts := array_append(v_creditor_amts, v_profile.bal);
    END IF;
  END LOOP;

  v_d_idx := 1;
  v_c_idx := 1;
  WHILE v_d_idx <= COALESCE(array_length(v_debtor_names, 1), 0)
    AND v_c_idx <= COALESCE(array_length(v_creditor_names, 1), 0) LOOP
    v_tx_amt := ROUND(LEAST(v_debtor_amts[v_d_idx], v_creditor_amts[v_c_idx]), 2);
    IF v_tx_amt > 0 THEN
      v_tx_json := v_tx_json || jsonb_build_array(jsonb_build_object(
        'from', v_debtor_names[v_d_idx],
        'to', v_creditor_names[v_c_idx],
        'amount', v_tx_amt
      ));
      v_debtor_amts[v_d_idx] := ROUND(v_debtor_amts[v_d_idx] - v_tx_amt, 2);
      v_creditor_amts[v_c_idx] := ROUND(v_creditor_amts[v_c_idx] - v_tx_amt, 2);
    END IF;
    IF v_debtor_amts[v_d_idx] <= 0.001 THEN
      v_d_idx := v_d_idx + 1;
    END IF;
    IF v_creditor_amts[v_c_idx] <= 0.001 THEN
      v_c_idx := v_c_idx + 1;
    END IF;
  END LOOP;

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

-- ---------------------------------------------------------------------------
-- 12. Explicitly restrict EXECUTE permissions for SECURITY DEFINER RPC functions
--     Revokes execution from PUBLIC/anon; grants to authenticated users only.
--     Internal role checks ensure only Admins can execute administrative logic.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

REVOKE ALL ON FUNCTION public.is_month_active(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_month_active(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.is_active_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_active_member(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.close_month(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_month(UUID, JSONB) TO authenticated;

REVOKE ALL ON FUNCTION public.start_new_month(TEXT, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_new_month(TEXT, DATE, DATE) TO authenticated;
