/**
 * Token mint — risk-checklist UI.
 *
 * Route   : `/orgs/[slug]/projects/[project]/tokens/new`.
 * Spec    : docs/spec/gateway-risk-model.md §9, annexe A (UX target).
 * Linked from : the "+ Mint token" button on `/tokens`.
 *
 * Server side (this file) :
 *   - resolve the user → org → project chain (auth).
 *   - load every provider binding + every bash binding's hosts.
 *   - for each provider present in the bindings, load the risk catalog
 *     entries and filter by `acceptable_in_envs` per binding env.
 *   - hand the assembled payload to the client form.
 *
 * The actual checklist + preview/mint orchestration lives in `mint-form.tsx`
 * (client component) — Server Components can't hold the per-keystroke
 * preview state.
 */

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import type { Provider, RiskEntry } from '@vaubaan/shared';

import { getSupabaseServer } from '@/lib/supabase/server';
import { getCatalog } from '@/lib/risk-catalog/loader';
import { Button, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';

import { MintForm, type MintFormBinding, type MintFormCatalog } from './mint-form';

export const dynamic = 'force-dynamic';

interface ProviderBindingRow {
  id: string;
  provider: Provider;
  resource_ref: string;
  display_name: string | null;
  environment: string | null;
}

interface BashHostRow {
  id: string;
  host_slug: string;
  host_address: string;
}

interface BashBindingRow {
  id: string;
  slug: string;
  display_name: string;
  hosts: BashHostRow[];
}

export default async function TokenMintPage({
  params,
}: {
  params: Promise<{ slug: string; project: string }>;
}) {
  const { slug, project } = await params;
  const supabase = await getSupabaseServer();

  const { data: userRes } = await supabase.auth.getUser();
  if (!userRes.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!org) notFound();

  // Membership check : the user must belong to the org.
  const { data: member } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('organization_id', org.id)
    .eq('user_id', userRes.user.id)
    .maybeSingle<{ user_id: string }>();
  if (!member) notFound();

  const { data: proj } = await supabase
    .from('projects')
    .select('id, slug, name')
    .eq('organization_id', org.id)
    .eq('slug', project)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!proj) notFound();

  // Provider bindings (github/vercel/supabase/railway).
  const { data: providerBindings } = await supabase
    .from('provider_bindings')
    .select('id, provider, resource_ref, display_name, environment')
    .eq('project_id', proj.id)
    .returns<ProviderBindingRow[]>();

  // Bash bindings — each host becomes its own binding (env=null, ref=host_slug).
  const { data: bashBindings } = await supabase
    .from('bash_bindings')
    .select('id, slug, display_name, hosts:ssh_bindings(id, host_slug, host_address)')
    .eq('project_id', proj.id)
    .returns<BashBindingRow[]>();

  // Flatten to the binding rows the form actually displays. We emit one
  // row per provider × resource × env combination so the form can group
  // and qualify risks per env (cf. spec §4.4).
  const bindings: MintFormBinding[] = [];
  for (const b of providerBindings ?? []) {
    bindings.push({
      provider: b.provider,
      resource_ref: b.resource_ref,
      env: b.environment ?? null,
      display_name: b.display_name ?? b.resource_ref,
    });
  }
  for (const b of bashBindings ?? []) {
    for (const h of b.hosts) {
      bindings.push({
        provider: 'bash',
        resource_ref: h.host_slug,
        env: null,
        display_name: `${b.display_name} @${h.host_slug}`,
      });
    }
  }

  // Load the catalogs for the providers present. For each entry we expose
  // only the fields the client needs — keeps the payload trim and avoids
  // serialising Slice patterns.
  const usedProviders = new Set<Provider>(bindings.map((b) => b.provider));
  const catalogs: MintFormCatalog[] = [];
  for (const provider of usedProviders) {
    const catalog = getCatalog(provider);
    if (!catalog) {
      // The catalog is missing — surface it gently in the UI rather than
      // hard-fail the page. The form's preview will refuse anyway.
      catalogs.push({ provider, entries: [], loaded: false });
      continue;
    }
    catalogs.push({
      provider,
      loaded: true,
      entries: catalog.entries.map((e) => entryToClient(e.entry)),
    });
  }

  return (
    <main>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 'var(--space-6)',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Mint token</h1>
          <Code>
            /{org.slug}/{proj.slug}/tokens/new
          </Code>
          <p
            style={{
              color: 'var(--text-muted)',
              fontSize: 'var(--text-sm)',
              maxWidth: 720,
              marginTop: 'var(--space-2)',
            }}
          >
            Pick the risks you accept on this session. The token can do anything that maps to an
            accepted risk ; everything else is denied at runtime. Greyed-out rows are either not
            acceptable in the binding env (catalog restriction) or not inherited from your token
            (you don&apos;t carry that risk).
          </p>
        </div>
        <Link href={`/orgs/${org.slug}/projects/${proj.slug}/tokens`}>
          <Button size="sm" variant="secondary">
            ← back
          </Button>
        </Link>
      </header>

      {bindings.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No bindings on this project</CardTitle>
          </CardHeader>
          <CardBody>
            <p style={{ marginTop: 0, color: 'var(--text-muted)' }}>
              A token must be bound to at least one resource. Add one from the project page first.
            </p>
            <Link href={`/orgs/${org.slug}/projects/${proj.slug}/bindings/new`}>
              <Button variant="primary">+ Bind a resource</Button>
            </Link>
          </CardBody>
        </Card>
      ) : (
        <MintForm
          orgSlug={org.slug}
          projectSlug={proj.slug}
          projectId={proj.id}
          bindings={bindings}
          catalogs={catalogs}
        />
      )}
    </main>
  );
}

/** Trim a RiskEntry down to the shape the client form needs. We send the
 *  catalog inline (10-15 entries × 5 providers = ~75 entries) which is
 *  smaller than spinning a `/api/v1/catalog` endpoint. */
function entryToClient(entry: RiskEntry): MintFormCatalog['entries'][number] {
  return {
    id: entry.id,
    label: entry.label,
    reason: entry.reason,
    vector: entry.vector,
    vector_overrides: entry.vector_overrides,
    acceptable_in_envs: entry.acceptable_in_envs ?? null,
    deprecated: entry.deprecated ?? false,
  };
}
