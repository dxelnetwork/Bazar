import { NextResponse } from 'next/server';
import { appendEntry, updateEntry, deleteEntry } from '../../../lib/sheets';
import { getAuthenticatedUser } from '../../../lib/serverAuth.js';
import { createAdminClient } from '../../../lib/supabaseAdmin.js';

/**
 * POST /api/sync
 * Syncs entry data and monthly cycle summaries to Google Sheets.
 *
 * Security Model:
 *  - All requests require a valid Supabase Bearer token.
 *  - 'delete', 'update', and 'monthlySummary' actions require Admin authorization.
 *  - 'upsert' action allows:
 *      * Regular members: can only sync entries they own (user_id === auth.uid())
 *        and only to the currently active month in bazar_months.
 *      * Admins: can sync authorized entries across users and cycles.
 */
export async function POST(req) {
  try {
    // 1. Authenticate user
    const { user, error: authError } = await getAuthenticatedUser(req);
    if (authError || !user) {
      return NextResponse.json(
        { error: authError || 'Authentication required' },
        { status: 401 }
      );
    }

    // 2. Look up user's profile to verify role
    const adminClient = createAdminClient();
    const { data: profile } = await adminClient
      .from('profiles')
      .select('id, name, role, status')
      .eq('id', user.id)
      .single();

    const isAdmin = profile?.role === 'admin';

    const body = await req.json();
    const { action = 'upsert', entry, person, monthId, monthName, snapshot } = body;

    // 3. Admin-only actions
    if (action === 'delete' || action === 'update' || action === 'monthlySummary') {
      if (!isAdmin) {
        return NextResponse.json(
          { error: `Forbidden: Admin authorization is required for '${action}'` },
          { status: 403 }
        );
      }

      if (action === 'monthlySummary') {
        if (!snapshot) {
          return NextResponse.json({ error: 'snapshot data is required' }, { status: 400 });
        }
        await appendEntry({
          id: `SUMMARY-${monthName || 'unknown'}`,
          bazar_date: snapshot.closed_at ? snapshot.closed_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
          person: profile?.name || 'Admin',
          item: `Monthly Summary: ${monthName || 'N/A'}`,
          category: 'SUMMARY',
          amount: Number(snapshot.settlement?.total || 0),
          notes: `Members: ${snapshot.members?.length || 0}, Per Person Share: €${Number(snapshot.settlement?.share || 0).toFixed(2)}`,
        });
        return NextResponse.json({ ok: true });
      }

      if (!entry?.id) {
        return NextResponse.json({ error: 'Entry id is required' }, { status: 400 });
      }

      if (action === 'delete') {
        await deleteEntry(entry.id);
      } else if (action === 'update') {
        await updateEntry({
          ...entry,
          person: person || profile?.name || 'Admin',
        });
      }

      return NextResponse.json({ ok: true });
    }

    // 4. Upsert action
    if (action === 'upsert') {
      if (!entry) {
        return NextResponse.json({ error: 'Entry data is required' }, { status: 400 });
      }

      const targetMonthId = entry.month_id || monthId;

      // Member security validations
      if (!isAdmin) {
        // Enforce ownership: member can only submit for themselves
        if (entry.user_id && entry.user_id !== user.id) {
          return NextResponse.json(
            { error: 'Forbidden: You cannot submit entries for another user' },
            { status: 403 }
          );
        }

        // Enforce active month check
        if (!targetMonthId) {
          return NextResponse.json(
            { error: 'Active month reference is required' },
            { status: 400 }
          );
        }

        const { data: month } = await adminClient
          .from('bazar_months')
          .select('id, status')
          .eq('id', targetMonthId)
          .single();

        if (!month || month.status !== 'active') {
          return NextResponse.json(
            { error: 'Forbidden: Entries can only be submitted to the active month' },
            { status: 403 }
          );
        }
      }

      // Determine reliable person name
      const syncPerson = isAdmin
        ? (person || profile?.name || 'Admin')
        : (profile?.name || user.email || 'Member');

      await appendEntry({
        ...entry,
        user_id: isAdmin ? (entry.user_id || user.id) : user.id,
        person: syncPerson,
      });

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unsupported action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
