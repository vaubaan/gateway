/**
 * `/onboarding` — first-login org creation. Phase 4 wave C.
 *
 * Server component that checks whether the authenticated user already
 * belongs to any organization. If they do, redirect to that org's
 * resources page; if not, render the org-creation form (client island).
 * The IdentityGate (mounted by the `(protected)` layout) handles the
 * crypto-key bootstrap before this page renders.
 */

import { redirect } from 'next/navigation';
import type { ReactElement } from 'react';

import { OnboardingForm } from '@/components/onboarding/OnboardingForm';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface OrgMembershipRow {
  readonly organization_id: string;
  readonly role: string;
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

export default async function OnboardingPage(): Promise<ReactElement> {
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseLike;
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect('/sign-in');
  }

  const { data: rowsRaw } = await supabase
    .from('org_members')
    .select('organization_id, role, organizations(slug)')
    .eq('user_id', userData.user.id)
    .limit(1);
  const rows = rowsRaw as ReadonlyArray<OrgMembershipRow> | null;
  if (rows && rows.length > 0) {
    const first = rows[0]!;
    const slug = first.organizations?.slug;
    if (slug) {
      redirect(`/orgs/${slug}/resources`);
    }
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8" data-testid="onboarding-page">
      <h1 className="text-xl font-semibold">Create your first organization</h1>
      <p className="text-sm text-neutral-700">
        Cloud Resource Manager groups resources by organization. You'll be the first admin.
      </p>
      <OnboardingForm />
    </main>
  );
}
