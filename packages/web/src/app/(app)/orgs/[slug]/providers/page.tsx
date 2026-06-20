import { LocalDate } from '@/components/LocalDate';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { loadProviderState, type ProviderState } from '@/lib/providers/state';
import { ProviderDisconnectButton } from '../provider-disconnect';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Row,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

// bash / ssh are per-project, not org-level — shown as static info cards below.
const ORG_PROVIDERS = ['github', 'vercel', 'supabase', 'railway', 'stripe'] as const;
type OrgProvider = (typeof ORG_PROVIDERS)[number];

const PASTE_TOKEN_PROVIDERS: ReadonlySet<string> = new Set(['stripe']);

const PROVIDER_LABEL: Record<OrgProvider, string> = {
  github: 'GitHub',
  vercel: 'Vercel',
  supabase: 'Supabase',
  railway: 'Railway',
  stripe: 'Stripe',
};

const PROVIDER_DESCRIPTION: Record<OrgProvider, string> = {
  github:
    'Install the Vaubaan Gateway GitHub App on the org or user account that owns the repos you want to expose.',
  vercel:
    'Install the Vaubaan Marketplace Integration on the team that owns the projects you want to expose.',
  supabase:
    'Paste a Supabase Management API personal access token (PAT) to allow Vaubaan to enumerate projects.',
  railway: 'Authorize the Vaubaan Gateway Railway app to manage the projects in your workspace.',
  stripe:
    'Paste a Stripe restricted API key (sk_test_* / sk_live_* / rk_*) to expose billing tools.',
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

  const states = await Promise.all(
    ORG_PROVIDERS.map(async (p): Promise<ProviderState> => {
      try {
        return await loadProviderState(org.id, p);
      } catch {
        return {
          provider: p,
          status: 'connected',
          connectedAt: null,
          connectedByEmail: null,
          serviceUrl: null,
          account: null,
          scopes: [],
          resources: [],
          error:
            'Could not load provider state (token decryption failed — wrong ENCRYPTION_MASTER_KEY?).',
        };
      }
    }),
  );

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
        <Card>
          <CardHeader>
            <Row gap="var(--space-3)">
              <CardTitle>Bash</CardTitle>
              <Badge tone="neutral">per-project</Badge>
            </Row>
            <Row gap="var(--space-2)">
              <Link href={`/orgs/${org.slug}/providers/bash`} style={{ textDecoration: 'none' }}>
                <Button size="sm" variant="secondary">
                  Info
                </Button>
              </Link>
            </Row>
          </CardHeader>
          <CardBody>
            <p style={{ margin: 0, color: 'var(--text-muted)' }}>
              A bash binding = an SSH-reachable host + an annotated bash script. Each function of
              the script becomes an MCP tool ; its <Code>{`# @vaubaan: ring=… action=…`}</Code>{' '}
              comments declare the required capability. Bindings live per-project — add one from the
              project&apos;s <strong>+ Bind a resource</strong> form.
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <Row gap="var(--space-3)">
              <CardTitle>SSH</CardTitle>
              <Badge tone="neutral">per-project</Badge>
            </Row>
            <Row gap="var(--space-2)">
              <Link href={`/orgs/${org.slug}/providers/ssh`} style={{ textDecoration: 'none' }}>
                <Button size="sm" variant="secondary">
                  Info
                </Button>
              </Link>
            </Row>
          </CardHeader>
          <CardBody>
            <p style={{ margin: 0, color: 'var(--text-muted)' }}>
              A standalone SSH host binding — direct command execution via <Code>ssh__exec</Code>.
              Each binding registers a single host (address, port, user, key). Add one from the
              project&apos;s <strong>+ Bind a resource</strong> form.
            </p>
          </CardBody>
        </Card>
      </div>
    </main>
  );
}

function ProviderCard({ state, orgSlug }: { state: ProviderState; orgSlug: string }) {
  const connected = state.status === 'connected';
  const label = PROVIDER_LABEL[state.provider as OrgProvider] ?? state.provider;
  return (
    <Card>
      <CardHeader>
        <Row gap="var(--space-3)">
          <CardTitle>{label}</CardTitle>
          {state.status === 'not_connected' ? (
            <Badge tone="neutral">not connected</Badge>
          ) : (
            <Badge tone={state.status === 'connected' ? 'success' : 'danger'}>{state.status}</Badge>
          )}
        </Row>
        <Row gap="var(--space-2)">
          <Link
            href={`/orgs/${orgSlug}/providers/${state.provider}`}
            style={{ textDecoration: 'none' }}
          >
            <Button size="sm" variant="secondary">
              Info
            </Button>
          </Link>
          {connected && (
            <ProviderDisconnectButton
              orgSlug={orgSlug}
              provider={state.provider as 'github' | 'vercel' | 'supabase' | 'railway' | 'stripe'}
            />
          )}
          {!connected && (
            <a
              href={
                PASTE_TOKEN_PROVIDERS.has(state.provider)
                  ? `/orgs/${orgSlug}/providers/${state.provider}/connect`
                  : `/api/integrations/${state.provider}/connect?org=${orgSlug}`
              }
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
            {PROVIDER_DESCRIPTION[state.provider as OrgProvider] ?? ''}
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
      {state.setupAction && (
        <Banner tone="warning">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 'var(--space-3)',
            }}
          >
            <span>{state.setupAction.message}</span>
            <a
              href={state.setupAction.actionUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{ textDecoration: 'none', flexShrink: 0 }}
            >
              <Button size="sm" variant="primary">
                {state.setupAction.actionLabel}
              </Button>
            </a>
          </div>
        </Banner>
      )}
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
              · <LocalDate ts={state.connectedAt} dateOnly />
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
