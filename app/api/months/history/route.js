import { NextResponse } from 'next/server';
import { getAuthenticatedUser, createUserClient } from '../../../../lib/serverAuth.js';

/**
 * GET /api/months/history
 * Returns all bazar_months ordered by start_date DESC.
 * Requires authentication (any role).
 */
export async function GET(request) {
  try {
    const { user, token, error: authError } = await getAuthenticatedUser(request);
    if (authError) {
      return NextResponse.json({ error: authError }, { status: 401 });
    }

    // Use the user's own client so RLS policies apply
    const userClient = createUserClient(token);

    const { data: months, error: queryError } = await userClient
      .from('bazar_months')
      .select('*')
      .order('start_date', { ascending: false });

    if (queryError) {
      return NextResponse.json({ error: queryError.message }, { status: 500 });
    }

    return NextResponse.json({ months });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
