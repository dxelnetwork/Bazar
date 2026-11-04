import { createClient } from '@supabase/supabase-js';

/**
 * Creates a Supabase client with the SERVICE_ROLE_KEY for server-side admin operations.
 * WARNING: This client bypasses Row Level Security. NEVER import this from client components.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing Supabase admin configuration');
  }
  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
