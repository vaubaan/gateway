import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { ProviderDisconnectButton } from './provider-disconnect';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Code, Row } from '@/components/ui';

export const dynamic = 'force-dynamic';

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
  const o = org;

  const [{ data: providers }, { data: projects }] = await Promise.all([
    supabase
      .from('provider_admins')
      .select('provider, status, connected_at')
      .eq('organization_id', o.id),
    supabase
      .from('projects')
      .select('id, name, slug, created_at')
      .eq('organization_id', o.id)
      .order('created_at', { ascending: false }),
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
          <h1 style={{ margin: 0 }}>{o.name}</h1>
          <Code>/{o.slug}</Code>
        </div>
        <Link href="/dashboard" style={{ color: 'var(--text-muted)' }}>
          ← all orgs
        </Link>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr',
          gap: 'var(--space-4)',
        }}
      >
        <section>
          <Card>
            <CardHeader>
              <CardTitle>Cloud providers</CardTitle>
            </CardHeader>
            <CardBody>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {(['github', 'vercel', 'supabase'] as const).map((p) => {
                  const row = (providers ?? []).find(
                    (x) => (x as { provider: string }).provider === p,
                  ) as { status: string; connected_at: string } | undefined;
                  return (
                    <li
                      key={p}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: 'var(--space-2) 0',
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      <Row>
                        <strong style={{ textTransform: 'capitalize' }}>{p}</strong>
                        <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>
                          {row
                            ? `connected ${new Date(row.connected_at).toLocaleDateString()}`
                            : 'not connected'}
                        </span>
                      </Row>
                      <Row gap="var(--space-2)">
                        {row && (
                          <Badge tone={row.status === 'connected' ? 'success' : 'danger'}>
                            {row.status}
                          </Badge>
                        )}
                        {row && row.status === 'connected' && (
                          <ProviderDisconnectButton orgSlug={o.slug} provider={p} />
                        )}
                        {!row && p === 'github' && (
                          <Link href={`/api/integrations/github/connect?org=${o.slug}`}>
                            <Button size="sm" variant="primary">
                              Connect
                            </Button>
                          </Link>
                        )}
                        {!row && p !== 'github' && (
                          <Badge tone="neutral">paste-token via API</Badge>
                        )}
                      </Row>
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>

          <div style={{ height: 'var(--space-4)' }} />

          <Card>
            <CardHeader>
              <CardTitle>Projects</CardTitle>
              <Link href={`/orgs/${o.slug}/projects/new`}>
                <Button size="sm" variant="primary">
                  + New project
                </Button>
              </Link>
            </CardHeader>
            <CardBody>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {(projects ?? []).map((p) => {
                  const proj = p as { id: string; name: string; slug: string };
                  return (
                    <li key={proj.id}>
                      <Link
                        href={`/orgs/${o.slug}/projects/${proj.slug}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          padding: 'var(--space-3) 0',
                          borderBottom: '1px solid var(--border-subtle)',
                          textDecoration: 'none',
                        }}
                      >
                        <span>
                          <strong>{proj.name}</strong>{' '}
                          <span style={{ color: 'var(--text-subtle)', marginLeft: 6 }}>
                            /{proj.slug}
                          </span>
                        </span>
                        <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>
                          open →
                        </span>
                      </Link>
                    </li>
                  );
                })}
                {(projects ?? []).length === 0 && (
                  <p style={{ color: 'var(--text-subtle)', margin: 0 }}>No projects yet.</p>
                )}
              </ul>
            </CardBody>
          </Card>
        </section>

        <aside style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <Card>
            <CardHeader>
              <CardTitle>Quick links</CardTitle>
            </CardHeader>
            <CardBody>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, lineHeight: 2 }}>
                <li>
                  <Link href={`/orgs/${o.slug}/roles`}>→ Roles catalog</Link>
                </li>
                <li>
                  <Link href={`/orgs/${o.slug}/members`}>→ Members</Link>
                </li>
                <li>
                  <Link href={`/orgs/${o.slug}/audit`}>→ Audit log</Link>
                </li>
              </ul>
            </CardBody>
          </Card>
        </aside>
      </div>
    </main>
  );
}
