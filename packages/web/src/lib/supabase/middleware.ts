/**
 * Edge middleware helper for Supabase auth cookie refresh.
 *
 * Called from `packages/web/src/middleware.ts` on every matched request
 * so that the user's session cookie is refreshed without forcing a full
 * route revalidation.
 */

import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

import { requireSupabaseConfig } from './config';

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { url, anonKey } = requireSupabaseConfig();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Trigger session refresh; ignore result, the cookie side-effects are
  // what we actually care about here.
  await supabase.auth.getUser();

  return response;
}
