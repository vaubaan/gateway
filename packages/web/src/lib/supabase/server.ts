/**
 * Server-side Supabase client using @supabase/ssr.
 *
 * Use this inside Server Components, route handlers, and server actions.
 * Reads cookies via `next/headers` so the user's session is honored and
 * RLS is correctly enforced on every query.
 *
 * Spec §3.3, §8: RLS is the first gate; this helper keeps the user's
 * identity end-to-end (no service-role bypass).
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { requireSupabaseConfig } from './config';

export async function createSupabaseServerClient(): Promise<ReturnType<typeof createServerClient>> {
  const { url, anonKey } = requireSupabaseConfig();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `cookies().set` throws when called from a Server Component;
          // ignore — middleware handles cookie refresh in that case.
        }
      },
    },
  });
}
