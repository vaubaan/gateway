import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Badge, Card, CardBody, CardHeader, CardTitle, Code, Row } from '@/components/ui';
import { LocalDate } from '@/components/LocalDate';
import { ServiceRunner } from './runner';
import type { ParsedService } from '@/lib/services/parse';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  bash_content: string;
  parsed_meta: ParsedService | null;
  parse_error: string | null;
  updated_at: string;
}

interface SshBindingRow {
  id: string;
  host_slug: string;
  host_address: string;
  ssh_user: string;
}

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ slug: string; project: string; serviceId: string }>;
}) {
  const { slug, project, serviceId } = await params;
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

  const { data: service } = await supabase
    .from('runner_services')
    .select(
      'id, slug, display_name, description, bash_content, parsed_meta, parse_error, updated_at',
    )
    .eq('project_id', proj.id)
    .eq('id', serviceId)
    .maybeSingle<Row>();
  if (!service) notFound();

  const { data: bindings } = await supabase
    .from('ssh_bindings')
    .select('id, host_slug, host_address, ssh_user')
    .eq('project_id', proj.id)
    .order('host_slug', { ascending: true })
    .returns<SshBindingRow[]>();

  return (
    <main>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <Row gap="var(--space-3)">
          <h1 style={{ margin: 0 }}>{service.display_name}</h1>
          <Code>{service.slug}</Code>
        </Row>
        <Code>
          /{org.slug}/{proj.slug}/services/{service.slug}
        </Code>{' '}
        ·{' '}
        <Link
          href={`/orgs/${org.slug}/projects/${proj.slug}/services`}
          style={{ color: 'var(--text-muted)' }}
        >
          ← services
        </Link>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {service.parse_error && (
          <Card>
            <CardHeader>
              <CardTitle>Parse error</CardTitle>
              <Badge tone="danger">invalid</Badge>
            </CardHeader>
            <CardBody>
              <pre
                style={{
                  margin: 0,
                  color: 'var(--accent-danger-fg)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                {service.parse_error}
              </pre>
            </CardBody>
          </Card>
        )}

        {service.parsed_meta && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Capability surface</CardTitle>
                <Badge tone="neutral">plane = {service.parsed_meta.plane}</Badge>
              </CardHeader>
              <CardBody>
                <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
                  Tools declared by this service, grouped by ring. The capability required to invoke
                  each tool follows the short notation when the plane is the default.
                </p>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {service.parsed_meta.rings.map((ring, idx) => {
                    const tools = service.parsed_meta!.tools.filter((t) => t.ring === ring);
                    return (
                      <li
                        key={ring}
                        style={{
                          padding: 'var(--space-3) 0',
                          borderBottom: '1px solid var(--border-subtle)',
                        }}
                      >
                        <Row gap="var(--space-2)">
                          <strong>ring {idx + 1}</strong>
                          <Code>{ring}</Code>
                          <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-sm)' }}>
                            {tools.length} tool{tools.length === 1 ? '' : 's'}
                          </span>
                        </Row>
                        <ul
                          style={{
                            listStyle: 'none',
                            padding: 0,
                            margin: 'var(--space-2) 0 0 var(--space-4)',
                            display: 'grid',
                            gap: 'var(--space-1)',
                          }}
                        >
                          {tools.map((t) => (
                            <li key={t.functionName} style={{ fontSize: 'var(--text-sm)' }}>
                              <Code>{t.functionName}</Code>{' '}
                              <Badge tone={t.action === 'write' ? 'warning' : 'success'}>
                                {t.action}
                              </Badge>{' '}
                              <span style={{ color: 'var(--text-subtle)' }}>
                                requires{' '}
                                <Code>
                                  {service.slug}:{ring}:{t.action}@&lt;host&gt;
                                </Code>
                              </span>
                              {t.doc && (
                                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                                  {t.doc}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              </CardBody>
            </Card>

            <ServiceRunner
              orgSlug={org.slug}
              serviceId={service.id}
              tools={service.parsed_meta.tools}
              bindings={(bindings ?? []).map((b) => ({
                host_slug: b.host_slug,
                host_address: b.host_address,
                ssh_user: b.ssh_user,
              }))}
            />
          </>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Source</CardTitle>
            <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>
              updated <LocalDate ts={service.updated_at} />
            </span>
          </CardHeader>
          <CardBody>
            <pre
              style={{
                margin: 0,
                padding: 'var(--space-3)',
                background: 'var(--surface-2)',
                borderRadius: 'var(--radius-md)',
                fontSize: 'var(--text-xs)',
                fontFamily: 'var(--font-mono)',
                overflow: 'auto',
                maxHeight: 400,
              }}
            >
              {service.bash_content}
            </pre>
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
