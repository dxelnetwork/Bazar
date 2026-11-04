import { NextResponse } from 'next/server';
import { appendEntry, updateEntry, deleteEntry } from '../../../lib/sheets';
import { getAuthenticatedUser } from '../../../lib/serverAuth.js';

/**
 * POST /api/sync
 * Syncs entry data to Google Sheets.
 * Now requires authentication and supports optional monthId and monthlySummary action.
 *
 * Actions:
 *   - upsert (default): Appends a new entry row
 *   - update: Appends an update row (with ADMIN UPDATE prefix)
 *   - delete: Deletes the entry row by id
 *   - monthlySummary: Writes a monthly summary row to Google Sheets on month close
 */
export async function POST(req) {
  try {
    // Authenticate the request
    const { user, error: authError } = await getAuthenticatedUser(req);
    if (authError) {
      return NextResponse.json({ error: authError }, { status: 401 });
    }

    const body = await req.json();
    const { action = 'upsert', entry, person, monthId, monthName, snapshot } = body;

    // Handle monthly summary action
    if (action === 'monthlySummary') {
      if (!snapshot) {
        return NextResponse.json({ error: 'snapshot data is required' }, { status: 400 });
      }
      // Write summary row to Google Sheets
      await appendEntry({
        id: `SUMMARY-${monthName || 'unknown'}`,
        bazar_date: snapshot.closed_at || new Date().toISOString(),
        person: 'SYSTEM',
        item: `Monthly Summary: ${monthName || 'N/A'}`,
        category: 'SUMMARY',
        amount: snapshot.settlement?.total || 0,
        notes: `Members: ${snapshot.members?.length || 0}, Share: ${snapshot.settlement?.share || 0}`,
      });
      return NextResponse.json({ ok: true });
    }

    // Existing entry sync actions
    if (!entry?.id) {
      return NextResponse.json({ error: 'Entry id is required' }, { status: 400 });
    }

    // Attach monthId to the entry if provided
    const entryWithMonth = monthId ? { ...entry, monthId } : entry;

    if (action === 'delete') {
      await deleteEntry(entryWithMonth.id);
    } else if (action === 'update') {
      await updateEntry({ ...entryWithMonth, person });
    } else {
      await appendEntry({ ...entryWithMonth, person });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
