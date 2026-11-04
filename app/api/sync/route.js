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
 *  - 'upsert' action:
 *      * Fetches the actual entry from Supabase using the supplied entry ID.
 *      * Verifies that the database entry exists and belongs to the authenticated user (for members).
 *      * Verifies that the entry's actual month_id belongs to an active month in bazar_months.
 *      * Syncs canonical database values (user_id, amount, item, date, month_id) rather than trusting client-supplied values.
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
    const { action = 'upsert', entry, person, monthName, snapshot } = body;

    // 3. Admin-only actions: 'delete', 'update', 'monthlySummary'
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
        return NextResponse.json({ ok: true });
      }

      if (action === 'update') {
        // Fetch canonical entry from database to ensure verified values
        const { data: dbEntry } = await adminClient
          .from('bazar_entries')
          .select('id, user_id, month_id, bazar_date, item, category, amount, notes')
          .eq('id', entry.id)
          .single();

        const updateData = dbEntry || entry;
        let personName = person || 'Admin';
        if (updateData.user_id) {
          const { data: p } = await adminClient
            .from('profiles')
            .select('name')
            .eq('id', updateData.user_id)
            .single();
          if (p?.name) personName = p.name;
        }

        await updateEntry({
          ...updateData,
          amount: Number(updateData.amount),
          person: personName,
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

      if (entryErr || !dbEntry) {
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

      if (monthErr || !month) {
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
