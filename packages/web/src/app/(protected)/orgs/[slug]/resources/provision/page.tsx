/**
 * `/orgs/:slug/resources/provision?admin=:rId&project=:projectId`
 *
 * Phase 6 wave C — Provisioning wizard entry point. The page itself
 * is a thin server-side gate that fetches the org id + the admin row
 * to confirm visibility; the actual wizard runs client-side in
 * <ProvisionWizard /> so it can unseal admin tokens in-browser.
 */

import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { ProvisionWizard } from '@/components/wizard/ProvisionWizard';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams: Promise<{ readonly admin?: string; readonly project?: string }>;
}

interface SupabaseLike {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string,
      ): {
        maybeSingle(): Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
}

export default async function ProvisionPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { slug } = await params;
  const { admin, project } = await searchParams;
  if (!admin) notFound();

  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseLike;
  const { data: orgRaw } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  const org = orgRaw as { id: string; slug: string; name: string } | null;
  if (!org) notFound();

  // Resolve a default project_id if none was passed (UI shortcut).
  let projectId: string | null = project ?? null;
  if (projectId === null) {
    const { data: projRaw } = await supabase
      .from('projects')
      .select('id')
      .eq('organization_id', org.id)
      .maybeSingle();
    const proj = projRaw as { id: string } | null;
    projectId = proj?.id ?? null;
  }
  if (projectId === null) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">Provision a resource</h1>
        <p className="text-sm text-red-700">
          This org has no project yet — provisioning requires a project to attach the new resource
          to. Create one via the org settings first.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Provision a resource</h1>
        <p className="text-xs text-neutral-600">
          org: {org.slug} · admin: <code>{admin}</code> · project: <code>{projectId}</code>
        </p>
      </header>
      <ProvisionWizard orgSlug={org.slug} adminResourceId={admin} projectId={projectId} />
    </main>
  );
}
