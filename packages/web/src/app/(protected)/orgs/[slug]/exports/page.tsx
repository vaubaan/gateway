/**
 * `/orgs/:slug/exports` — org-scoped exports page.
 *
 * Spec §11.1.
 *
 * Buttons:
 *   - `<DotenvExportButton scope=org />` — `.env` for the whole org.
 *   - `<McpExportButton scope=org />` — mcp.json + .env companion.
 *   - `<CloudResourceMapButton orgSlug />` — cloud-resource-map.json.
 *   - `<RegenerateMcpButton scope=org />` — admin only (server returns
 *      403 to non-admins; the button surfaces the error inline).
 *
 * The variant selector narrows the dotenv/mcp scope when the user
 * wants a `.env` for a specific variant (`staging`, `prod`, …).
 *
 * Server component : fetches the org + the distinct variants present
 * across the org's Resources to populate the dropdown.
 */

import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { OrgExportsClient } from '@/components/exports/OrgExportsClient';
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
        order(
          col: string,
          opts: { ascending: boolean },
        ): Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

export default async function OrgExportsPage({ params }: PageProps): Promise<ReactElement> {
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
    .select('variant')
    .eq('organization_id', org.id)
    .order('variant', { ascending: true });
  if (error) {
    throw new Error(`Failed to load resources: ${error.message}`);
  }
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
        <h1 className="text-xl font-semibold">{org.name} — Exports</h1>
        <p className="text-xs text-neutral-600">
          org: {org.slug} · download bundles assembled from the visible Resources. Sealed blobs are
          unsealed in your browser — Core never sees cleartext.
        </p>
      </header>
      <OrgExportsClient orgSlug={org.slug} variants={variants} />
    </main>
  );
}
