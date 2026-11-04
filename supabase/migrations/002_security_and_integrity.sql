-- =============================================================================
-- Migration: 002_security_and_integrity.sql
-- Purpose:   Harden profile privilege security, closed month immutability,
--            UUID-keyed settlement data integrity, and strict RPC permissions.
-- Safe to run on existing production databases. Idempotent & non-destructive.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Profile Security: Prevent Privilege Escalation
--    - Members can only update their own permitted fields (e.g. name, whatsapp)
--    - Members can NEVER change their own role or status
--    - Only Admins can modify another user's role or status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_profile_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If the caller is NOT an admin, forbid modifying role, status, or id
  IF NOT public.is_admin() THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'Privilege escalation denied: Only admin can modify user roles';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Permission denied: Only admin can modify account status';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Permission denied: User ID cannot be altered';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_profile_update ON profiles;
CREATE TRIGGER trg_check_profile_update
BEFORE UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION public.check_profile_update();

-- Update profiles RLS policy to reinforce check
DROP POLICY IF EXISTS "profiles self or admin update" ON profiles;
CREATE POLICY "profiles self or admin update" ON profiles FOR UPDATE
  USING (id = auth.uid() OR public.is_admin())
  WITH CHECK (id = auth.uid() OR public.is_admin());

-- ---------------------------------------------------------------------------
-- 2. Closed Month Immutability: Protect Bazar Entries
--    - Once a month is closed, NO ONE (including Admin) may edit or delete entries
--    - Enforced via both RLS policies and database trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_entry_month_active()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT public.is_month_active(OLD.month_id) THEN
      RAISE EXCEPTION 'Closed month immutability: Cannot delete entries from a closed month';
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT public.is_month_active(OLD.month_id) THEN
      RAISE EXCEPTION 'Closed month immutability: Cannot modify entries belonging to a closed month';
    END IF;
    IF NOT public.is_month_active(NEW.month_id) THEN
      RAISE EXCEPTION 'Closed month immutability: Cannot move entries into a closed month';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_entry_month_active ON bazar_entries;
CREATE TRIGGER trg_check_entry_month_active
BEFORE UPDATE OR DELETE ON bazar_entries
FOR EACH ROW EXECUTE FUNCTION public.check_entry_month_active();

-- Restrict Admin UPDATE and DELETE policies to active months only
DROP POLICY IF EXISTS "entries admin update" ON bazar_entries;
DROP POLICY IF EXISTS "entries admin update active month only" ON bazar_entries;
CREATE POLICY "entries admin update active month only" ON bazar_entries FOR UPDATE
  USING (public.is_admin() AND public.is_month_active(month_id))
  WITH CHECK (public.is_admin() AND public.is_month_active(month_id));

DROP POLICY IF EXISTS "entries admin delete" ON bazar_entries;
DROP POLICY IF EXISTS "entries admin delete active month only" ON bazar_entries;
CREATE POLICY "entries admin delete active month only" ON bazar_entries FOR DELETE
  USING (public.is_admin() AND public.is_month_active(month_id));

-- ---------------------------------------------------------------------------
-- 3. Closed Month Immutability: Protect bazar_months Records & Snapshots
--    - Closed months and their settlement snapshots cannot be edited or deleted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_closed_month_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'Closed month immutability: Closed month records and settlement snapshots are permanent and cannot be modified';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_closed_month_immutable ON bazar_months;
CREATE TRIGGER trg_check_closed_month_immutable
BEFORE UPDATE OR DELETE ON bazar_months
FOR EACH ROW EXECUTE FUNCTION public.check_closed_month_immutable();

DROP POLICY IF EXISTS "months admin update" ON bazar_months;
CREATE POLICY "months admin update" ON bazar_months FOR UPDATE
  USING (public.is_admin() AND status = 'active')
  WITH CHECK (public.is_admin());

-- ---------------------------------------------------------------------------
-- 4. Server-Side Month Closure & UUID-Keyed Settlement Data Integrity
--    - Rejects month closure if there are no active members
--    - Uses Supabase user UUIDs as keys for totals and balances (handles duplicate names)
--    - Computes totals, equal share, balances, and transactions 100% server-side
--    - Never trusts client-provided calculations
--    - Saves authoritative immutable snapshot
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
  v_totals_by_id JSONB := '{}'::JSONB;
  v_balances_by_id JSONB := '{}'::JSONB;
  v_entries_json JSONB;
  v_authoritative_snapshot JSONB;

  v_profile RECORD;
  v_spent NUMERIC(12,2);
  v_bal NUMERIC(12,2);

  -- Transaction settlement arrays (UUID-keyed)
  v_debtor_ids UUID[] := '{}';
  v_debtor_names TEXT[] := '{}';
  v_debtor_amts NUMERIC[] := '{}';

  v_creditor_ids UUID[] := '{}';
  v_creditor_names TEXT[] := '{}';
  v_creditor_amts NUMERIC[] := '{}';

  v_d_idx INT := 1;
  v_c_idx INT := 1;
  v_tx_amt NUMERIC(12,2);
  v_tx_json JSONB := '[]'::JSONB;
BEGIN
  -- 1. Admin verification
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admin can close a month';
  END IF;

  -- 2. Lock and validate month
  SELECT * INTO v_month FROM bazar_months WHERE id = p_month_id FOR UPDATE;

  IF v_month IS NULL THEN
    RAISE EXCEPTION 'Month not found';
  END IF;

  IF v_month.status = 'closed' THEN
    RAISE EXCEPTION 'Month is already closed';
  END IF;

  -- 3. Count active participating members
  SELECT COUNT(*) INTO v_members
  FROM profiles
  WHERE status = 'active';

  -- Reject closure if no active members exist
  IF v_members IS NULL OR v_members = 0 THEN
    RAISE EXCEPTION 'Cannot close month: No active members found. At least one active member is required for settlement.';
  END IF;

  -- 4. Calculate canonical total expenditure directly from actual database entries
  SELECT ROUND(COALESCE(SUM(amount), 0), 2) INTO v_total
  FROM bazar_entries WHERE month_id = p_month_id;

  -- 5. Calculate canonical equal share per active member
  v_share := ROUND(v_total / v_members, 2);

  -- 6. Build authoritative member list
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'role', p.role
  ) ORDER BY p.name), '[]'::JSONB)
  INTO v_members_json
  FROM profiles p
  WHERE p.status = 'active';

  -- 7. Calculate member expenditures and balances using user UUID as keys
  FOR v_profile IN (
    SELECT
      p.id,
      p.name,
      ROUND(COALESCE(spent.total_spent, 0), 2) AS total_spent
    FROM profiles p
    LEFT JOIN (
      SELECT user_id, ROUND(COALESCE(SUM(amount), 0), 2) AS total_spent
      FROM bazar_entries
      WHERE month_id = p_month_id
      GROUP BY user_id
    ) spent ON spent.user_id = p.id
    WHERE p.status = 'active'
    ORDER BY p.name ASC
  ) LOOP
    v_spent := v_profile.total_spent;
    v_bal := ROUND(v_spent - v_share, 2);

    -- Store using UUID keys to handle duplicate member names safely
    v_totals_by_id := v_totals_by_id || jsonb_build_object(v_profile.id::TEXT, v_spent);
    v_balances_by_id := v_balances_by_id || jsonb_build_object(v_profile.id::TEXT, v_bal);

    IF v_bal < -0.001 THEN
      v_debtor_ids := array_append(v_debtor_ids, v_profile.id);
      v_debtor_names := array_append(v_debtor_names, v_profile.name);
      v_debtor_amts := array_append(v_debtor_amts, -v_bal);
    ELSIF v_bal > 0.001 THEN
      v_creditor_ids := array_append(v_creditor_ids, v_profile.id);
      v_creditor_names := array_append(v_creditor_names, v_profile.name);
      v_creditor_amts := array_append(v_creditor_amts, v_bal);
    END IF;
  END LOOP;

  -- 8. Calculate settlement transactions server-side (who pays whom and how much)
  v_d_idx := 1;
  v_c_idx := 1;
  WHILE v_d_idx <= COALESCE(array_length(v_debtor_ids, 1), 0)
    AND v_c_idx <= COALESCE(array_length(v_creditor_ids, 1), 0) LOOP
    v_tx_amt := ROUND(LEAST(v_debtor_amts[v_d_idx], v_creditor_amts[v_c_idx]), 2);
    IF v_tx_amt > 0 THEN
      v_tx_json := v_tx_json || jsonb_build_array(jsonb_build_object(
        'fromId', v_debtor_ids[v_d_idx],
        'fromName', v_debtor_names[v_d_idx],
        'from', v_debtor_names[v_d_idx],
        'toId', v_creditor_ids[v_c_idx],
        'toName', v_creditor_names[v_c_idx],
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

  -- 9. Build authoritative entries list directly from database
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'user_id', e.user_id,
    'person', p.name,
    'bazar_date', e.bazar_date,
    'item', e.item,
    'category', e.category,
    'amount', e.amount,
    'notes', e.notes
  ) ORDER BY e.bazar_date DESC, e.created_at DESC), '[]'::JSONB)
  INTO v_entries_json
  FROM bazar_entries e
  JOIN profiles p ON p.id = e.user_id
  WHERE e.month_id = p_month_id;

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
    'closed_at', NOW(),
    'closed_by', auth.uid()
  );

  -- 11. Atomically store snapshot and close month
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
-- 5. RPC Security: Revoke EXECUTE from PUBLIC/anon and grant to authenticated
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

REVOKE ALL ON FUNCTION public.is_month_active(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_month_active(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.is_active_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_member(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.close_month(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_month(UUID, JSONB) TO authenticated;

REVOKE ALL ON FUNCTION public.start_new_month(TEXT, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_new_month(TEXT, DATE, DATE) TO authenticated;

