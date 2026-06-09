import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { LocalDate } from '@/components/LocalDate';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Code, Row } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface ServiceRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  parsed_meta: {
    rings: string[];
    tools: Array<{ functionName: string; ring: string; action: 'read' | 'write' }>;
  } | null;
  parse_error: string | null;
  updated_at: string;
}

export default async function ServicesPage({
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

  const { data: services } = await supabase
    .from('runner_services')
    .select('id, slug, display_name, description, parsed_meta, parse_error, updated_at')
    .eq('project_id', proj.id)
    .order('created_at', { ascending: true })
    .returns<ServiceRow[]>();

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
          <h1 style={{ margin: 0 }}>Services</h1>
          <Code>
            /{org.slug}/{proj.slug}/services
          </Code>
        </div>
        <Link
          href={`/orgs/${org.slug}/projects/${proj.slug}`}
          style={{ color: 'var(--text-muted)' }}
        >
          ← project
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Annotated-bash services</CardTitle>
          <Link href={`/orgs/${org.slug}/projects/${proj.slug}/services/new`}>
            <Button size="sm" variant="primary">
              + New service
            </Button>
          </Link>
        </CardHeader>
        <CardBody>
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
            A service is a bash file whose functions are annotated with <Code>{`# @vaubaan:`}</Code>{' '}
            comments. Each annotated function becomes an MCP tool ; the annotations define the ring
            &amp; read/write capability it requires. The service executes over the project&apos;s
            SSH bindings.
          </p>

          {(services ?? []).length === 0 ? (
            <p style={{ color: 'var(--text-subtle)', margin: 0 }}>
              No service yet. Start with the <Code>runner</Code> example.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {(services ?? []).map((s) => (
                <li
                  key={s.id}
                  style={{
                    padding: 'var(--space-3) 0',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <Link
                    href={`/orgs/${org.slug}/projects/${proj.slug}/services/${s.id}`}
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <Row gap="var(--space-2)">
                      <strong>{s.display_name}</strong>
                      <Code>{s.slug}</Code>
                      {s.parse_error ? (
                        <Badge tone="danger">parse error</Badge>
                      ) : (
                        <Badge tone="neutral">
                          {s.parsed_meta?.tools?.length ?? 0} tools ·{' '}
                          {s.parsed_meta?.rings?.length ?? 0} rings
                        </Badge>
                      )}
                    </Row>
                    {s.description && (
                      <p
                        style={{
                          margin: '4px 0 0',
                          color: 'var(--text-muted)',
                          fontSize: 'var(--text-sm)',
                        }}
                      >
                        {s.description}
                      </p>
                    )}
                    <span
                      style={{
                        color: 'var(--text-subtle)',
                        fontSize: 'var(--text-xs)',
                      }}
                    >
                      updated <LocalDate ts={s.updated_at} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </main>
  );
}
