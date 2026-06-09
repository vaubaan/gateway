import { LocalDate } from '@/components/LocalDate';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { type Provider } from '@vaubaan/shared';

// ssh is per-project via ssh_bindings, not org-level — excluded here.
const ORG_PROVIDERS = ['github', 'vercel', 'supabase', 'railway'] as const;
import { getSupabaseServer } from '@/lib/supabase/server';
import { loadProviderState } from '@/lib/providers/state';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';
import { BindingControls } from './binding-controls';
import { SshBindingControls } from './ssh-binding-controls';

export const dynamic = 'force-dynamic';

interface BindingRow {
  id: string;
  provider: Provider;
  resource_ref: string;
  display_name: string | null;
}

interface SshBindingRow {
  id: string;
  host_slug: string;
  host_address: string;
  port: number;
  ssh_user: string;
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
    { data: sshBindings },
    { data: tokens },
    providerStates,
    { count: pendingApprovals },
    { count: policyRulesCount },
    { count: servicesCount },
  ] = await Promise.all([
    supabase
      .from('provider_bindings')
      .select('id, provider, resource_ref, display_name')
      .eq('project_id', proj.id)
      .returns<BindingRow[]>(),
    supabase
      .from('ssh_bindings')
      .select('id, host_slug, host_address, port, ssh_user')
      .eq('project_id', proj.id)
      .returns<SshBindingRow[]>(),
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
    supabase
      .from('runner_services')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', proj.id),
  ]);

  const resourcesByProvider: Partial<Record<Provider, Array<{ ref: string; name: string }>>> = {
    github: [],
    vercel: [],
    supabase: [],
    railway: [],
    ssh: [],
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
              <Link href={`/orgs/${org.slug}/projects/${proj.slug}/services`}>
                <Button size="sm" variant="secondary">
                  Services ({servicesCount ?? 0})
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
            {(bindings ?? []).length === 0 && (sshBindings ?? []).length === 0 ? (
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
                {(sshBindings ?? []).length > 0 && (
                  <li
                    key="ssh-group"
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
                      <Badge tone="neutral">ssh</Badge>
                      <Code>{(sshBindings ?? []).length} hosts</Code>
                      <span style={{ color: 'var(--text-subtle)', fontSize: 12 }}>
                        each host_slug becomes an env in the <Code>ssh:host/shell</Code>{' '}
                        capabilities.
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
                      {(sshBindings ?? []).map((b) => (
                        <li
                          key={`ssh-${b.id}`}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 'var(--space-3)',
                            padding: 'var(--space-2) 0',
                          }}
                        >
                          <Code>
                            @{b.host_slug} · {b.ssh_user}@{b.host_address}:{b.port}
                          </Code>
                          <SshBindingControls
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
