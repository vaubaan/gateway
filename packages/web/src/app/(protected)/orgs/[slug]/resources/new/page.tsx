/**
 * `/orgs/:slug/resources/new` — Register Resource wizard. Spec §7.1, §11.1.
 *
 * Server component that loads the catalogue (build-time metadata via
 * `@crm/catalog`) and hands it off to the client-side wizard.
 */

import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { CATALOG } from '@crm/catalog';

import { RegisterWizard } from '@/components/wizard/RegisterWizard';
import { serializeKind } from '@/lib/catalog/serialize';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

interface SupabaseLike {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string,
      ): {
        maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

export default async function RegisterResourcePage({ params }: PageProps): Promise<ReactElement> {
  const { slug } = await params;
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseLike;
  const { data: orgRaw } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  if (!orgRaw) notFound();

  const kinds = CATALOG.map(serializeKind);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Register a resource</h1>
        <p className="text-xs text-muted">org: {slug}</p>
      </header>
      <RegisterWizard orgSlug={slug} kinds={kinds} />
    </main>
  );
}
