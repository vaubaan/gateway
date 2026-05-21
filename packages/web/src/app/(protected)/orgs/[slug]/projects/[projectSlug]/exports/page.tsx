/**
 * `/orgs/:slug/projects/:projectSlug/exports` — project-scoped exports.
 *
 * Spec §11.1.
 *
 * Server resolves :
 *   - the org row;
 *   - the project row by slug (the `projects` table key the public
 *     URL).
 *   - the distinct variants used by the project's Resources, so the
 *     variant dropdown is populated client-side.
 *
 * Renders the same buttons as the org-level page, but without the
 * cloud-resource-map (that one is always org-scoped per spec §6.7.1).
 */

import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { ProjectExportsClient } from '@/components/exports/ProjectExportsClient';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly slug: string; readonly projectSlug: string }>;
}

interface OrgRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

interface ProjectRow {
  readonly id: string;
  readonly slug: string;
  readonly organization_id: string;
}

interface ResourceRow {
  readonly variant: string | null;
}

interface SupabaseLike {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string,
      ): {
        maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
        eq(
          col2: string,
          val2: string,
        ): {
          maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
          order(
            col: string,
            opts: { ascending: boolean },
          ): Promise<{ data: unknown; error: { message: string } | null }>;
        };
        order(
          col: string,
          opts: { ascending: boolean },
        ): Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

export default async function ProjectExportsPage({ params }: PageProps): Promise<ReactElement> {
  const { slug, projectSlug } = await params;
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseLike;

  const { data: orgRaw } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  const org = orgRaw as OrgRow | null;
  if (!org) notFound();

  const { data: projRaw } = await supabase
    .from('projects')
    .select('id, slug, organization_id')
    .eq('organization_id', org.id)
    .eq('slug', projectSlug)
    .maybeSingle();
  const project = projRaw as ProjectRow | null;
  if (!project) notFound();

  const { data: resourcesRaw } = await supabase
    .from('resources')
    .select('variant')
    .eq('organization_id', org.id)
    .eq('project_id', project.id)
    .order('variant', { ascending: true });
  const variants = Array.from(
    new Set(
      ((resourcesRaw as ReadonlyArray<ResourceRow> | null) ?? [])
        .map((r) => r.variant)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  ).sort();

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          {org.name} / {project.slug} — Exports
        </h1>
        <p className="text-xs text-neutral-600">
          project-scoped bundles include the project Resources + the org-scoped Resources of{' '}
          {org.slug}. Sealed blobs are unsealed in your browser.
        </p>
      </header>
      <ProjectExportsClient
        orgSlug={org.slug}
        projectId={project.id}
        projectSlug={project.slug}
        variants={variants}
      />
    </main>
  );
}
