/**
 * Browser-side Supabase client using @supabase/ssr.
 *
 * Use this in Client Components ("use client"). Reads the NEXT_PUBLIC_*
 * env vars at build time. NEVER import the service-role key here.
 */

import { createBrowserClient } from '@supabase/ssr';

import { requireSupabaseConfig } from './config';

export function createSupabaseBrowserClient(): ReturnType<typeof createBrowserClient> {
  const { url, anonKey } = requireSupabaseConfig();
  return createBrowserClient(url, anonKey);
}
