import { LocalDate } from '@/components/LocalDate';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { type Provider } from '@vaubaan/shared';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';
import { BindingControls } from './binding-controls';
import { BashBindingControls } from './bash-binding-controls';

export const dynamic = 'force-dynamic';

interface BindingRow {
  id: string;
  provider: Provider;
  resource_ref: string;
  display_name: string | null;
  environment: string | null;
}

interface BashBindingRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  parsed_meta: { tools: Array<{ functionName: string }>; rings: string[] } | null;
  parse_error: string | null;
  hosts: Array<{ id: string; host_slug: string; host_address: string; ssh_user: string }>;
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

  const [{ data: bindings }, { data: bashBindings }, { data: tokens }] = await Promise.all([
    supabase
      .from('provider_bindings')
      .select('id, provider, resource_ref, display_name, environment')
      .eq('project_id', proj.id)
      .returns<BindingRow[]>(),
    supabase
      .from('bash_bindings')
      .select(
        'id, slug, display_name, description, parsed_meta, parse_error, hosts:ssh_bindings(id, host_slug, host_address, ssh_user)',
      )
      .eq('project_id', proj.id)
      .order('created_at', { ascending: true })
      .returns<BashBindingRow[]>(),
    supabase
      .from('tokens')
      .select('id, name, api_key_prefix, status, last_used_at')
      .eq('project_id', proj.id)
      .order('created_at', { ascending: false })
      .returns<TokenRow[]>(),
  ]);

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
                      {b.environment ? (
                        <>
                          <Code>{b.environment}</Code>
                          <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>
                            ({b.display_name ?? b.resource_ref})
                          </span>
                        </>
                      ) : (
                        <Code>{b.display_name ?? b.resource_ref}</Code>
                      )}
                    </span>
                    <BindingControls binding={b} orgSlug={org.slug} projectSlug={proj.slug} />
                  </li>
                ))}
                {(bashBindings ?? []).map((b) => (
                  <li
                    key={`bash-${b.id}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                      padding: 'var(--space-3) 0',
                      borderBottom: '1px solid var(--border-subtle)',
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
                        flexWrap: 'wrap',
                      }}
                    >
                      <Badge tone="neutral">bash</Badge>
                      <Code>{b.display_name}</Code>
                      {b.parse_error ? (
                        <Badge tone="danger">parse error</Badge>
                      ) : b.parsed_meta ? (
                        <Badge tone="success">
                          {b.parsed_meta.tools.length} tools · {b.hosts.length} host
                          {b.hosts.length === 1 ? '' : 's'}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">no script · {b.hosts.length} hosts</Badge>
                      )}
                      <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>
                        {b.hosts.map((h) => `@${h.host_slug}`).join(', ')}
                      </span>
                    </Link>
                    <BashBindingControls
                      bindingId={b.id}
                      displayName={b.display_name}
                      orgSlug={org.slug}
                      detailHref={`/orgs/${org.slug}/projects/${proj.slug}/bash-bindings/${b.id}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Access tokens</CardTitle>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              Mint via <Code>POST /api/v1/mgmt/tokens</Code>
            </span>
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
                    <span>
                      <strong>{t.name}</strong> <Code>vbn_live_{t.api_key_prefix}…</Code>
                    </span>
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
