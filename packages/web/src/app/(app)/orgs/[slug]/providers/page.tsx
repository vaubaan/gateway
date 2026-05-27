import { notFound, redirect } from 'next/navigation';
import { PROVIDERS, type Provider } from '@vaubaan/shared';
import { getSupabaseServer } from '@/lib/supabase/server';
import { loadProviderState, type ProviderState } from '@/lib/providers/state';
import { ProviderDisconnectButton } from '../provider-disconnect';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Code, Row } from '@/components/ui';

export const dynamic = 'force-dynamic';

const PROVIDER_LABEL: Record<Provider, string> = {
  github: 'GitHub',
  vercel: 'Vercel',
  supabase: 'Supabase',
};

const PROVIDER_DESCRIPTION: Record<Provider, string> = {
  github:
    'Install the Vaubaan Gateway GitHub App on the org or user account that owns the repos you want to expose.',
  vercel:
    'Install the Vaubaan Marketplace Integration on the team that owns the projects you want to expose.',
  supabase:
    'Paste a Supabase Management API personal access token (PAT) to allow Vaubaan to enumerate projects.',
};

export default async function OrgPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle<{ id: string; name: string; slug: string }>();
  if (!org) notFound();

  const states = await Promise.all(PROVIDERS.map((p) => loadProviderState(org.id, p)));

  return (
    <main>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 'var(--space-6)',
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Cloud providers</h1>
          <Code>/{org.slug}</Code>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{org.name}</span>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {states.map((s) => (
          <ProviderCard key={s.provider} state={s} orgSlug={org.slug} />
        ))}
      </div>
    </main>
  );
}

function ProviderCard({ state, orgSlug }: { state: ProviderState; orgSlug: string }) {
  const connected = state.status === 'connected';
  return (
    <Card>
      <CardHeader>
        <Row gap="var(--space-3)">
          <CardTitle>{PROVIDER_LABEL[state.provider]}</CardTitle>
          {state.status === 'not_connected' ? (
            <Badge tone="neutral">not connected</Badge>
          ) : (
            <Badge tone={state.status === 'connected' ? 'success' : 'danger'}>{state.status}</Badge>
          )}
        </Row>
        <Row gap="var(--space-2)">
          {connected && <ProviderDisconnectButton orgSlug={orgSlug} provider={state.provider} />}
          {!connected && (
            <a
              href={`/api/integrations/${state.provider}/connect?org=${orgSlug}`}
              style={{ textDecoration: 'none' }}
            >
              <Button size="sm" variant="primary">
                Connect
              </Button>
            </a>
          )}
        </Row>
      </CardHeader>
      <CardBody>
        {!connected ? (
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            {PROVIDER_DESCRIPTION[state.provider]}
          </p>
        ) : (
          <ProviderDetails state={state} />
        )}
      </CardBody>
    </Card>
  );
}

function ProviderDetails({ state }: { state: ProviderState }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          rowGap: 'var(--space-2)',
          columnGap: 'var(--space-4)',
          margin: 0,
          fontSize: 'var(--text-sm)',
        }}
      >
        <Term>Account</Term>
        <Desc>
          {state.serviceUrl ? (
            <a
              href={state.serviceUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: 'var(--text-foreground)' }}
            >
              {state.account ?? 'Manage on provider →'}
            </a>
          ) : (
            (state.account ?? '—')
          )}
        </Desc>

        <Term>Granted by</Term>
        <Desc>
          {state.connectedByEmail ?? '—'}{' '}
          {state.connectedAt && (
            <span style={{ color: 'var(--text-subtle)' }}>
              · {new Date(state.connectedAt).toLocaleDateString()}
            </span>
          )}
        </Desc>

        <Term>Scope</Term>
        <Desc>
          {state.scopes.length === 0 ? (
            <span style={{ color: 'var(--text-subtle)' }}>—</span>
          ) : (
            <ul
              style={{
                listStyle: 'disc',
                paddingLeft: 'var(--space-4)',
                margin: 0,
                color: 'var(--text-muted)',
              }}
            >
              {state.scopes.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
        </Desc>

        <Term>Resources</Term>
        <Desc>
          {state.error ? (
            <span style={{ color: 'var(--accent-danger-fg)' }}>{state.error}</span>
          ) : state.resources.length === 0 ? (
            <span style={{ color: 'var(--text-subtle)' }}>None visible.</span>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'grid',
                gap: 'var(--space-1)',
                maxHeight: 200,
                overflowY: 'auto',
              }}
            >
              {state.resources.map((r) => (
                <li key={r.ref} style={{ fontSize: 'var(--text-sm)' }}>
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer noopener">
                      <Code>{r.name}</Code>
                    </a>
                  ) : (
                    <Code>{r.name}</Code>
                  )}
                  {r.description && (
                    <span style={{ color: 'var(--text-subtle)', marginLeft: 6 }}>
                      {r.description}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Desc>
      </dl>
    </div>
  );
}

function Term({ children }: { children: React.ReactNode }) {
  return (
    <dt style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)', paddingTop: 2 }}>
      {children}
    </dt>
  );
}

function Desc({ children }: { children: React.ReactNode }) {
  return <dd style={{ margin: 0, color: 'var(--text-foreground)' }}>{children}</dd>;
}
