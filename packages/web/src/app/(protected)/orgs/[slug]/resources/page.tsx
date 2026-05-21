/**
 * `/orgs/:slug/resources` — Resources listing page. Spec §11.1.
 *
 * Server component. The Supabase server client carries the user's
 * session and RLS picks the row set automatically. The (protected)
 * layout already gates this page behind a signed-in user with an
 * unlocked crypto identity.
 *
 * The page renders:
 * - Header with org slug + actions (Register, Provision-via — disabled
 *   until Phase 6).
 * - `<ResourceTable>` for client-side filtering.
 */

import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { ResourceTable, type ResourceRow } from '@/components/resources/ResourceTable';
import { ProvisionLauncher } from '@/components/wizard/ProvisionLauncher';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

interface OrgRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

interface SupabaseLike {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string,
      ): {
        maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
        order(
          col: string,
          opts: { ascending: boolean },
        ): Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

export default async function ResourcesPage({ params }: PageProps): Promise<ReactElement> {
  const { slug } = await params;
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseLike;

  const { data: orgRaw } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  const org = orgRaw as OrgRow | null;
  if (!org) notFound();

  const { data: resourcesRaw, error } = await supabase
    .from('resources')
    .select(
      'id, organization_id, project_id, provider_name, kind, scope, is_admin, name, variant, status, connection_status, connection_checked_at, connection_message',
    )
    .eq('organization_id', org.id)
    .order('created_at', { ascending: false });
  if (error) {
    throw new Error(`Failed to load resources: ${error.message}`);
  }
  const resources = (resourcesRaw as ReadonlyArray<ResourceRow> | null) ?? [];

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{org.name} — Resources</h1>
          <p className="text-xs text-neutral-600">org: {org.slug}</p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/orgs/${org.slug}/resources/new`}
            data-testid="resources-page-register-button"
            className="rounded bg-neutral-900 px-3 py-1 text-sm text-white"
          >
            + Register
          </a>
          <ProvisionLauncher orgSlug={org.slug} resources={resources} />
        </div>
      </header>

      <ResourceTable orgSlug={org.slug} resources={resources} />
    </main>
  );
}
