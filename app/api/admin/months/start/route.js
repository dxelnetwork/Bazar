import { NextResponse } from 'next/server';
import { getAdminUser, createUserClient } from '../../../../../lib/serverAuth.js';

/**
 * POST /api/admin/months/start
 * Starts a new bazar month. Admin-only.
 *
 * Body: { monthName, startDate, endDate }
 * Calls the `start_new_month` RPC function using the authenticated user's context.
 */
export async function POST(request) {
  try {
    const { user, token, error: authError } = await getAdminUser(request);
    if (authError) {
      return NextResponse.json({ error: authError }, { status: 401 });
    }

    const body = await request.json();
    const { monthName, startDate, endDate } = body;

    // Validation
    const errors = [];
    if (!monthName?.trim()) errors.push('monthName is required');
    if (!startDate) errors.push('startDate is required');
    if (!endDate) errors.push('endDate is required');

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
    }

    // Create a Supabase client with the user's token for the RPC call
    const userClient = createUserClient(token);

    const { data, error: rpcError } = await userClient.rpc('start_new_month', {
      p_month_name: monthName.trim(),
      p_start_date: startDate,
      p_end_date: endDate,
    });

    if (rpcError) {
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, monthId: data });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
