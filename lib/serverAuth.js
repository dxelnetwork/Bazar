import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from './supabaseAdmin.js';

/**
 * Creates a Supabase client scoped to a specific user's access token.
 * Used for RPC calls that should run in the context of the authenticated user.
 */
export function createUserClient(token) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}

/**
 * Extracts and validates the authenticated user from the request's Authorization header.
 * Returns { user, token, error }.
 */
export async function getAuthenticatedUser(request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, token: null, error: 'No authorization token' };
  }
  const token = authHeader.replace('Bearer ', '');

  // Create a fresh Supabase client and verify the token
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { user: null, token: null, error: 'Invalid or expired token' };
  }

  return { user, token, error: null };
}

/**
 * Validates that the request comes from an authenticated admin user.
 * Checks the admin role server-side from the profiles table (never trusts client claims).
 * Returns { user, token, error }.
 */
export async function getAdminUser(request) {
  const { user, token, error } = await getAuthenticatedUser(request);
  if (error) return { user: null, token: null, error };

  // Verify admin role from the database using the service role client
  const adminClient = createAdminClient();

  const { data: profile } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    return { user: null, token: null, error: 'Admin access required' };
  }

  return { user: { ...user, role: 'admin' }, token, error: null };
}
