/**
 * Landing — server-side redirect dispatcher.
 *
 *   not signed in              → /sign-in
 *   signed in, no org          → /onboarding
 *   signed in, member of one+  → /orgs/<first-org-slug>/resources
 *
 * Mirrors the typing pattern used in `/onboarding/page.tsx` so the
 * supabase-js result lands as a fully-typed row without leaking
 * `unsafe-member-access` warnings.
 */

import { redirect } from 'next/navigation';

import { createSupabaseServerClient } from '@/lib/supabase/server';

// Per-request : we read the auth session + org membership. Prerender
// would have no session and no env vars at build time on Vercel.
export const dynamic = 'force-dynamic';

interface OrgMembershipRow {
  readonly organizations: { slug: string } | null;
}

interface SupabaseLike {
  auth: { getUser(): Promise<{ data: { user: { id: string } | null } }> };
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string,
      ): {
        limit(n: number): Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

export default async function HomePage(): Promise<never> {
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseLike;
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) redirect('/sign-in');

  const { data: rowsRaw } = await supabase
    .from('org_members')
    .select('organizations:organization_id(slug)')
    .eq('user_id', userData.user.id)
    .limit(1);

  const rows = rowsRaw as ReadonlyArray<OrgMembershipRow> | null;
  const firstSlug = rows?.[0]?.organizations?.slug;
  if (!firstSlug) redirect('/onboarding');
  redirect(`/orgs/${firstSlug}/resources`);
}
