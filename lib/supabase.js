import { createClient } from '@supabase/supabase-js';

// During build, env vars may not be set. Create a lazy singleton
// that only initializes when first accessed at runtime.
let _client = null;

function getClient() {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    if (!url || !key) {
      // Return a stub during build/SSG to avoid crashes
      return new Proxy({}, {
        get() {
          return () => new Proxy({}, {
            get() {
              return () => ({ data: null, error: { message: 'Supabase not configured' } });
            }
          });
        }
      });
    }
    _client = createClient(url, key);
  }
  return _client;
}

// Named export used by the app
export const supabase = new Proxy({}, {
  get(_, prop) {
    return getClient()[prop];
  }
});
