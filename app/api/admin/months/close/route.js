import { NextResponse } from 'next/server';
import { getAdminUser, createUserClient } from '../../../../../lib/serverAuth.js';

/**
 * POST /api/admin/months/close
 * Closes the active bazar month. Admin-only.
 *
 * Body: { monthId, settlementSnapshot }
 * Calls the `close_month` RPC function using the authenticated user's context.
 */
export async function POST(request) {
  try {
    const { user, token, error: authError } = await getAdminUser(request);
    if (authError) {
      return NextResponse.json({ error: authError }, { status: 401 });
    }

    const body = await request.json();
    const { monthId, settlementSnapshot } = body;

    if (!monthId) {
      return NextResponse.json({ error: 'monthId is required' }, { status: 400 });
    }

    // Create a Supabase client with the user's token for the RPC call
    // The RPC function is SECURITY DEFINER and checks is_admin internally
    const userClient = createUserClient(token);

    const { data, error: rpcError } = await userClient.rpc('close_month', {
      p_month_id: monthId,
      p_settlement_snapshot: settlementSnapshot || null,
    });

    if (rpcError) {
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
