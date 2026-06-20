import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import type { Provider, RiskEntry, RiskId } from '@vaubaan/shared';

import { getSupabaseServer } from '@/lib/supabase/server';
import { getCatalog } from '@/lib/risk-catalog/loader';
import { LocalDate } from '@/components/LocalDate';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';

import { TokenDetailRisks } from './token-detail-risks';
import type { MintFormBinding, MintFormCatalog } from '../new/mint-types';

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

interface TokenRow {
  id: string;
  name: string;
  api_key_prefix: string;
  status: string;
  accepted_risks: RiskId[];
  expires_at: string | null;
  single_use: boolean;
  consumed_at: string | null;
  last_used_at: string | null;
  created_at: string;
  project_id: string;
}

export default async function TokenDetailPage({
  params,
}: {
  params: Promise<{ slug: string; project: string; tokenId: string }>;
}) {
  const { slug, project, tokenId } = await params;
  const supabase = await getSupabaseServer();

  const { data: userRes } = await supabase.auth.getUser();
  if (!userRes.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!org) notFound();

  const { data: proj } = await supabase
    .from('projects')
    .select('id, slug, name')
    .eq('organization_id', org.id)
    .eq('slug', project)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!proj) notFound();

  const { data: token } = await supabase
    .from('tokens')
    .select(
      'id, name, api_key_prefix, status, accepted_risks, expires_at, single_use, consumed_at, last_used_at, created_at, project_id',
    )
    .eq('id', tokenId)
    .eq('project_id', proj.id)
    .maybeSingle<TokenRow>();
  if (!token) notFound();

  const { data: providerBindings } = await supabase
    .from('provider_bindings')
    .select('id, provider, resource_ref, display_name, environment')
    .eq('project_id', proj.id)
    .returns<ProviderBindingRow[]>();

  const { data: bashBindings } = await supabase
    .from('bash_bindings')
    .select('id, slug, display_name, hosts:ssh_bindings(id, host_slug, host_address)')
    .eq('project_id', proj.id)
    .returns<BashBindingRow[]>();

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

  const usedProviders = new Set<Provider>(bindings.map((b) => b.provider));
  const catalogs: MintFormCatalog[] = [];
  for (const provider of usedProviders) {
    const catalog = getCatalog(provider);
    if (!catalog) {
      catalogs.push({ provider, entries: [], loaded: false });
      continue;
    }
    catalogs.push({
      provider,
      loaded: true,
      entries: catalog.entries.map((e) => entryToClient(e.entry)),
    });
  }

  const acceptedRisks: RiskId[] = Array.isArray(token.accepted_risks) ? token.accepted_risks : [];

  const isExpired = token.expires_at ? new Date(token.expires_at) < new Date() : false;
  const isConsumed = token.single_use && token.consumed_at !== null;

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
          <h1 style={{ margin: 0 }}>{token.name}</h1>
          <Code>vbn_live_{token.api_key_prefix}...</Code>
        </div>
        <Link href={`/orgs/${org.slug}/projects/${proj.slug}/tokens`}>
          <Button size="sm" variant="secondary">
            &larr; back
          </Button>
        </Link>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-4)', paddingBottom: 'var(--space-8)' }}>
        <Card>
          <CardHeader>
            <CardTitle>Token info</CardTitle>
          </CardHeader>
          <CardBody>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: 'var(--space-2) var(--space-4)',
                margin: 0,
                fontSize: 'var(--text-sm)',
              }}
            >
              <dt style={{ color: 'var(--text-muted)' }}>Status</dt>
              <dd style={{ margin: 0 }}>
                {token.status === 'active' && !isExpired && !isConsumed ? (
                  <Badge tone="success">active</Badge>
                ) : token.status === 'revoked' ? (
                  <Badge tone="danger">revoked</Badge>
                ) : isExpired ? (
                  <Badge tone="warning">expired</Badge>
                ) : isConsumed ? (
                  <Badge tone="warning">consumed</Badge>
                ) : (
                  <Badge tone="neutral">{token.status}</Badge>
                )}
              </dd>

              <dt style={{ color: 'var(--text-muted)' }}>Expires</dt>
              <dd style={{ margin: 0 }}>
                {token.expires_at ? <LocalDate ts={token.expires_at} /> : 'never'}
              </dd>

              <dt style={{ color: 'var(--text-muted)' }}>Single-use</dt>
              <dd style={{ margin: 0 }}>
                {token.single_use ? 'yes' : 'no'}
                {isConsumed && token.consumed_at && (
                  <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                    (consumed <LocalDate ts={token.consumed_at} />)
                  </span>
                )}
              </dd>

              <dt style={{ color: 'var(--text-muted)' }}>Created</dt>
              <dd style={{ margin: 0 }}>
                <LocalDate ts={token.created_at} />
              </dd>

              {token.last_used_at && (
                <>
                  <dt style={{ color: 'var(--text-muted)' }}>Last used</dt>
                  <dd style={{ margin: 0 }}>
                    <LocalDate ts={token.last_used_at} />
                  </dd>
                </>
              )}

              <dt style={{ color: 'var(--text-muted)' }}>Accepted risks</dt>
              <dd style={{ margin: 0 }}>{acceptedRisks.length}</dd>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bindings ({bindings.length})</CardTitle>
          </CardHeader>
          <CardBody>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-2)',
              }}
            >
              {bindings.map((b) => (
                <li
                  key={`${b.provider}-${b.resource_ref}-${b.env ?? ''}`}
                  style={{
                    display: 'inline-flex',
                    gap: 6,
                    alignItems: 'center',
                    padding: '4px 8px',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-raised)',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  <Badge tone="neutral">{b.provider}</Badge>
                  {b.env && <Code>{b.env}</Code>}
                  <span style={{ color: 'var(--text-muted)' }}>{b.display_name}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        <TokenDetailRisks bindings={bindings} catalogs={catalogs} acceptedRisks={acceptedRisks} />
      </div>
    </main>
  );
}

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
