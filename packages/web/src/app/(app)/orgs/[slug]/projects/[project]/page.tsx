import { LocalDate } from '@/components/LocalDate';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { type Provider } from '@vaubaan/shared';

// bash is per-project (table ssh_bindings, kept for storage continuity),
// not org-level — excluded from ORG_PROVIDERS.
const ORG_PROVIDERS = ['github', 'vercel', 'supabase', 'railway'] as const;
import { getSupabaseServer } from '@/lib/supabase/server';
import { loadProviderState } from '@/lib/providers/state';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';
import { BindingControls } from './binding-controls';
import { BashBindingControls } from './bash-binding-controls';

export const dynamic = 'force-dynamic';

interface BindingRow {
  id: string;
  provider: Provider;
  resource_ref: string;
  display_name: string | null;
}

interface BashBindingRow {
  id: string;
  host_slug: string;
  host_address: string;
  port: number;
  ssh_user: string;
  parsed_meta: { tools: Array<{ functionName: string }>; rings: string[] } | null;
}

interface TokenRow {
  id: string;
  name: string;
  api_key_prefix: string;
  status: 'active' | 'revoked';
  last_used_at: string | null;
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string; project: string }>;
}) {
  const { slug, project } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

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

  const [
    { data: bindings },
    { data: bashBindings },
    { data: tokens },
    providerStates,
    { count: pendingApprovals },
    { count: policyRulesCount },
  ] = await Promise.all([
    supabase
      .from('provider_bindings')
      .select('id, provider, resource_ref, display_name')
      .eq('project_id', proj.id)
      .returns<BindingRow[]>(),
    supabase
      .from('ssh_bindings')
      .select('id, host_slug, host_address, port, ssh_user, parsed_meta')
      .eq('project_id', proj.id)
      .returns<BashBindingRow[]>(),
    supabase
      .from('access_tokens')
      .select('id, name, api_key_prefix, status, last_used_at')
      .eq('project_id', proj.id)
      .order('created_at', { ascending: false })
      .returns<TokenRow[]>(),
    Promise.all(ORG_PROVIDERS.map((p) => loadProviderState(org.id, p as Provider))),
    supabase
      .from('approval_requests')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', proj.id)
      .eq('status', 'pending'),
    supabase
      .from('policy_rules')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', proj.id),
  ]);

  const resourcesByProvider: Partial<Record<Provider, Array<{ ref: string; name: string }>>> = {
    github: [],
    vercel: [],
    supabase: [],
    railway: [],
    bash: [],
  };
  for (const s of providerStates) {
    resourcesByProvider[s.provider] = s.resources.map((r) => ({ ref: r.ref, name: r.name }));
  }

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
          <h1 style={{ margin: 0 }}>{proj.name}</h1>
          <Code>
            /{org.slug}/{proj.slug}
          </Code>
        </div>
        <Link href={`/orgs/${org.slug}`} style={{ color: 'var(--text-muted)' }}>
          ← all projects
        </Link>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Card>
          <CardHeader>
            <CardTitle>Policy &amp; approvals</CardTitle>
            <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Link href={`/orgs/${org.slug}/projects/${proj.slug}/rings`}>
                <Button size="sm" variant="secondary">
                  Capability rings
                </Button>
              </Link>
              <Link href={`/orgs/${org.slug}/projects/${proj.slug}/policy`}>
                <Button size="sm" variant="secondary">
                  Policy rules ({policyRulesCount ?? 0})
                </Button>
              </Link>
              <Link href={`/orgs/${org.slug}/projects/${proj.slug}/approvals`}>
                <Button size="sm" variant={pendingApprovals ? 'primary' : 'secondary'}>
                  Approvals ({pendingApprovals ?? 0} pending)
                </Button>
              </Link>
            </span>
          </CardHeader>
          <CardBody>
            <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 'var(--text-sm)' }}>
              Mint requests with human-gated capabilities (per the project&apos;s policy_rules) are
              held until a human approves via Telegram or here. Tighten the policy in{' '}
              <em>Policy rules</em> ; clear the queue in <em>Approvals</em>.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider bindings</CardTitle>
            <Link href={`/orgs/${org.slug}/projects/${proj.slug}/bindings/new`}>
              <Button size="sm" variant="primary">
                + Bind a resource
              </Button>
            </Link>
          </CardHeader>
          <CardBody>
            {(bindings ?? []).length === 0 && (bashBindings ?? []).length === 0 ? (
              <p style={{ color: 'var(--text-subtle)', margin: 0 }}>No bindings yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {(bindings ?? []).map((b) => (
                  <li
                    key={b.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                      padding: 'var(--space-3) 0',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                      <Badge tone="neutral">{b.provider}</Badge>
                      <Code>{b.display_name ?? b.resource_ref}</Code>
                    </span>
                    <BindingControls
                      binding={b}
                      orgSlug={org.slug}
                      resources={resourcesByProvider[b.provider] ?? []}
                    />
                  </li>
                ))}
                {(bashBindings ?? []).length > 0 && (
                  <li
                    key="bash-group"
                    style={{
                      padding: 'var(--space-3) 0',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        marginBottom: 'var(--space-2)',
                      }}
                    >
                      <Badge tone="neutral">bash</Badge>
                      <Code>{(bashBindings ?? []).length} hosts</Code>
                      <span style={{ color: 'var(--text-subtle)', fontSize: 12 }}>
                        each host_slug is an env in{' '}
                        <Code>bash:&lt;ring&gt;:&lt;action&gt;@&lt;host&gt;</Code> capabilities.
                      </span>
                    </div>
                    <ul
                      style={{
                        listStyle: 'none',
                        padding: 0,
                        margin: 0,
                        paddingLeft: 'var(--space-4)',
                      }}
                    >
                      {(bashBindings ?? []).map((b) => (
                        <li
                          key={`bash-${b.id}`}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 'var(--space-3)',
                            padding: 'var(--space-2) 0',
                          }}
                        >
                          <Link
                            href={`/orgs/${org.slug}/projects/${proj.slug}/bash-bindings/${b.id}`}
                            style={{
                              textDecoration: 'none',
                              color: 'inherit',
                              display: 'inline-flex',
                              gap: 'var(--space-2)',
                              alignItems: 'center',
                            }}
                          >
                            <Code>
                              @{b.host_slug} · {b.ssh_user}@{b.host_address}:{b.port}
                            </Code>
                            <Badge tone={b.parsed_meta ? 'success' : 'neutral'}>
                              {b.parsed_meta ? `${b.parsed_meta.tools.length} tools` : 'no script'}
                            </Badge>
                          </Link>
                          <BashBindingControls
                            bindingId={b.id}
                            hostSlug={b.host_slug}
                            orgSlug={org.slug}
                          />
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Access tokens</CardTitle>
            <Link href={`/orgs/${org.slug}/projects/${proj.slug}/tokens/new`}>
              <Button size="sm" variant="primary">
                + New access token
              </Button>
            </Link>
          </CardHeader>
          <CardBody>
            {(tokens ?? []).length === 0 ? (
              <p style={{ color: 'var(--text-subtle)', margin: 0 }}>No access tokens yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {(tokens ?? []).map((t) => (
                  <li
                    key={t.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      padding: 'var(--space-3) 0',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <Link
                      href={`/orgs/${org.slug}/projects/${proj.slug}/tokens/${t.id}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                    >
                      <strong>{t.name}</strong> <Code>vbn_live_{t.api_key_prefix}…</Code>
                    </Link>
                    <span
                      style={{
                        color: 'var(--text-subtle)',
                        fontSize: 'var(--text-sm)',
                        display: 'flex',
                        gap: 'var(--space-2)',
                        alignItems: 'center',
                      }}
                    >
                      <Badge tone={t.status === 'active' ? 'success' : 'danger'}>{t.status}</Badge>
                      {t.last_used_at && (
                        <span>
                          used <LocalDate ts={t.last_used_at} />
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
