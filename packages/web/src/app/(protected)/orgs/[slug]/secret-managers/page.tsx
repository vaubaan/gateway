/**
 * `/orgs/:slug/secret-managers` — SecretManagers listing page.
 *
 * Server component. RLS picks the visible row set automatically through
 * the session-bound Supabase client.
 *
 * Spec §11.1, §6.2. Phase 5 Wave B.
 */

import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import {
  SecretManagerList,
  type SecretManagerRowProps,
} from '@/components/secret-managers/SecretManagerList';
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

export default async function SecretManagersPage({ params }: PageProps): Promise<ReactElement> {
  const { slug } = await params;
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseLike;

  const { data: orgRaw } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  const org = orgRaw as OrgRow | null;
  if (!org) notFound();

  const { data: smsRaw, error } = await supabase
    .from('secret_managers')
    .select('id, organization_id, kind, name, is_default, config, created_at')
    .eq('organization_id', org.id)
    .order('created_at', { ascending: false });
  if (error) {
    throw new Error(`Failed to load secret_managers: ${error.message}`);
  }
  const items = (smsRaw as ReadonlyArray<SecretManagerRowProps> | null) ?? [];

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{org.name} — SecretManagers</h1>
          <p className="text-xs text-muted">org: {org.slug}</p>
        </div>
        <a
          href={`/orgs/${org.slug}/secret-managers/new`}
          data-testid="sm-page-connect-button"
          className="inline-flex h-7 items-center justify-center rounded-sm border border-primary bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90"
        >
          + Connect Infisical Workspace
        </a>
      </header>
      <SecretManagerList orgSlug={org.slug} items={items} />
    </main>
  );
}
