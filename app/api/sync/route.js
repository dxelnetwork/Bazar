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
 *  - 'delete', 'update', and 'monthlySummary' actions strictly require Admin authorization.
 *  - 'update' action:
 *      * Fetches the database entry strictly by ID.
 *      * Rejects with 404/500 if non-existent or query fails.
 *      * Never falls back to client-provided data.
 *      * Uses only canonical database values.
 *  - 'monthlySummary' action:
 *      * Accepts a monthId.
 *      * Fetches the closed month and its stored settlement_snapshot directly from Supabase.
 *      * Verifies that the month is closed.
 *      * Generates the Google Sheets summary solely from the database snapshot.
 *  - 'upsert' action:
 *      * Fetches the actual entry from Supabase using the supplied entry ID.
 *      * Verifies that the database entry exists and belongs to the authenticated user (for members).
 *      * Verifies that the entry's actual month_id belongs to an active month in bazar_months.
 *      * Syncs canonical database values (user_id, amount, item, date, month_id).
 *      * Rejects missing, mismatched, or unauthorized entries.
 */
export async function POST(req) {
  try {
    // 1. Authenticate user from Bearer token
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
    const { action = 'upsert', entry, person, monthId } = body;

    // 3. Admin-only actions: 'delete', 'update', 'monthlySummary'
    if (action === 'delete' || action === 'update' || action === 'monthlySummary') {
      if (!isAdmin) {
        return NextResponse.json(
          { error: `Forbidden: Admin authorization is required for '${action}'` },
          { status: 403 }
        );
      }

      // Action: monthlySummary
      if (action === 'monthlySummary') {
        const targetMonthId = monthId || body.month_id;
        if (!targetMonthId) {
          return NextResponse.json(
            { error: 'monthId is required for monthlySummary' },
            { status: 400 }
          );
        }

        // Fetch closed month and its stored settlement_snapshot directly from database
        const { data: dbMonth, error: monthErr } = await adminClient
          .from('bazar_months')
          .select('id, month_name, status, total_amount, total_members, per_person_share, settlement_snapshot, closed_at')
          .eq('id', targetMonthId)
          .single();

        if (monthErr) {
          return NextResponse.json(
            { error: `Database error querying month: ${monthErr.message}` },
            { status: 500 }
          );
        }

        if (!dbMonth) {
          return NextResponse.json(
            { error: 'Monthly cycle not found in database' },
            { status: 404 }
          );
        }

        if (dbMonth.status !== 'closed') {
          return NextResponse.json(
            { error: `Cannot generate summary: Month '${dbMonth.month_name}' is not closed.` },
            { status: 400 }
          );
        }

        const storedSnapshot = dbMonth.settlement_snapshot || {};
        const totalAmount = Number(dbMonth.total_amount ?? storedSnapshot.settlement?.total ?? 0);
        const membersCount = dbMonth.total_members ?? storedSnapshot.members?.length ?? 0;
        const shareAmount = Number(dbMonth.per_person_share ?? storedSnapshot.settlement?.share ?? 0);
        const closeDate = dbMonth.closed_at
          ? dbMonth.closed_at.slice(0, 10)
          : new Date().toISOString().slice(0, 10);

        await appendEntry({
          id: `SUMMARY-${dbMonth.id}`,
          bazar_date: closeDate,
          person: profile?.name || 'Admin',
          item: `Monthly Summary: ${dbMonth.month_name}`,
          category: 'SUMMARY',
          amount: totalAmount,
          notes: `Total Members: ${membersCount}, Per Person Share: €${shareAmount.toFixed(2)}`,
        });

        return NextResponse.json({ ok: true });
      }

      if (!entry?.id) {
        return NextResponse.json({ error: 'Entry id is required' }, { status: 400 });
      }

      // Action: delete
      if (action === 'delete') {
        await deleteEntry(entry.id);
        return NextResponse.json({ ok: true });
      }

      // Action: update (Admin only)
      if (action === 'update') {
        // Fetch database entry strictly by ID
        const { data: dbEntry, error: queryErr } = await adminClient
          .from('bazar_entries')
          .select('id, user_id, month_id, bazar_date, item, category, amount, notes')
          .eq('id', entry.id)
          .single();

        if (queryErr) {
          return NextResponse.json(
            { error: `Database error querying entry: ${queryErr.message}` },
            { status: 500 }
          );
        }

        if (!dbEntry) {
          return NextResponse.json(
            { error: 'Entry not found in database. Cannot sync non-existent entry.' },
            { status: 404 }
          );
        }

        // Fetch canonical profile name for the entry's user
        let personName = 'Admin';
        if (dbEntry.user_id) {
          const { data: p } = await adminClient
            .from('profiles')
            .select('name')
            .eq('id', dbEntry.user_id)
            .single();
          if (p?.name) personName = p.name;
        }

        // Use ONLY canonical database values — never fall back to client-provided data
        await updateEntry({
          id: dbEntry.id,
          bazar_date: dbEntry.bazar_date,
          person: personName,
          item: dbEntry.item,
          category: dbEntry.category || '',
          amount: Number(dbEntry.amount),
          notes: dbEntry.notes || '',
          month_id: dbEntry.month_id,
          user_id: dbEntry.user_id,
        });

        return NextResponse.json({ ok: true });
      }
    }

    // 4. Upsert action: Verify against actual database entry
    if (action === 'upsert') {
      if (!entry?.id) {
        return NextResponse.json(
          { error: 'Valid entry id is required for synchronization' },
          { status: 400 }
        );
      }

      // Fetch the actual bazar entry from Supabase
      const { data: dbEntry, error: entryErr } = await adminClient
        .from('bazar_entries')
        .select('id, user_id, month_id, bazar_date, item, category, amount, notes, created_at')
        .eq('id', entry.id)
        .single();

      if (entryErr) {
        return NextResponse.json(
          { error: `Database error querying entry: ${entryErr.message}` },
          { status: 500 }
        );
      }

      if (!dbEntry) {
        return NextResponse.json(
          { error: 'Entry not found in database. Cannot sync uncommitted entry.' },
          { status: 404 }
        );
      }

      // For regular members: verify database entry belongs to the authenticated user
      if (!isAdmin) {
        if (dbEntry.user_id !== user.id) {
          return NextResponse.json(
            { error: 'Forbidden: You do not own this database entry' },
            { status: 403 }
          );
        }

        // Reject client-supplied mismatched values
        if (entry.user_id && entry.user_id !== user.id) {
          return NextResponse.json(
            { error: 'Forbidden: Mismatched client user_id' },
            { status: 403 }
          );
        }
      }

      // Verify entry's actual month_id references an active month in bazar_months
      if (!dbEntry.month_id) {
        return NextResponse.json(
          { error: 'Forbidden: Entry has no assigned monthly cycle' },
          { status: 400 }
        );
      }

      const { data: month, error: monthErr } = await adminClient
        .from('bazar_months')
        .select('id, status, month_name')
        .eq('id', dbEntry.month_id)
        .single();

      if (monthErr) {
        return NextResponse.json(
          { error: `Database error querying month: ${monthErr.message}` },
          { status: 500 }
        );
      }

      if (!month) {
        return NextResponse.json(
          { error: 'Referenced monthly cycle does not exist' },
          { status: 404 }
        );
      }

      if (month.status !== 'active') {
        return NextResponse.json(
          { error: `Forbidden: Entry belongs to closed month '${month.month_name}'. Sync rejected.` },
          { status: 403 }
        );
      }

      // Retrieve canonical member name from profiles
      const { data: entryProfile } = await adminClient
        .from('profiles')
        .select('name')
        .eq('id', dbEntry.user_id)
        .single();

      const canonicalPerson = entryProfile?.name || profile?.name || 'Member';

      // Write canonical database values to Google Sheets
      await appendEntry({
        id: dbEntry.id,
        bazar_date: dbEntry.bazar_date,
        person: canonicalPerson,
        item: dbEntry.item,
        category: dbEntry.category || '',
        amount: Number(dbEntry.amount),
        notes: dbEntry.notes || '',
        month_id: dbEntry.month_id,
        user_id: dbEntry.user_id,
      });

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unsupported action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
