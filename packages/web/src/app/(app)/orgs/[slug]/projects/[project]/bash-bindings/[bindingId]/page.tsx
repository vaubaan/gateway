import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Badge, Card, CardBody, CardHeader, CardTitle, Code, Row } from '@/components/ui';
import { LocalDate } from '@/components/LocalDate';
import { ScriptCard } from './script-card';
import { HostsCard } from './hosts-card';
import { RunnerCard } from './runner-card';
import type { ParsedScript } from '@/lib/bash/parse';

export const dynamic = 'force-dynamic';

interface BindingRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  bash_content: string | null;
  parsed_meta: ParsedScript | null;
  parse_error: string | null;
  created_at: string;
  updated_at: string;
}

interface HostRow {
  id: string;
  host_slug: string;
  host_address: string;
  port: number;
  ssh_user: string;
  created_at: string;
}

export default async function BashBindingPage({
  params,
}: {
  params: Promise<{ slug: string; project: string; bindingId: string }>;
}) {
  const { slug, project, bindingId } = await params;
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

  const { data: binding } = await supabase
    .from('bash_bindings')
    .select(
      'id, slug, display_name, description, bash_content, parsed_meta, parse_error, created_at, updated_at',
    )
    .eq('project_id', proj.id)
    .eq('id', bindingId)
    .maybeSingle<BindingRow>();
  if (!binding) notFound();

  const { data: hosts } = await supabase
    .from('ssh_bindings')
    .select('id, host_slug, host_address, port, ssh_user, created_at')
    .eq('bash_binding_id', binding.id)
    .order('host_slug', { ascending: true })
    .returns<HostRow[]>();

  return (
    <main>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <Row gap="var(--space-3)">
          <h1 style={{ margin: 0 }}>
            Bash · <Code>{binding.display_name}</Code>
          </h1>
          {binding.parsed_meta ? (
            <Badge tone="success">{binding.parsed_meta.tools.length} tools</Badge>
          ) : binding.parse_error ? (
            <Badge tone="danger">parse error</Badge>
          ) : (
            <Badge tone="neutral">no script</Badge>
          )}
          <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>
            updated <LocalDate ts={binding.updated_at} />
          </span>
        </Row>
        <Code>
          /{org.slug}/{proj.slug}/bash-bindings/{binding.slug}
        </Code>{' '}
        ·{' '}
        <Link
          href={`/orgs/${org.slug}/projects/${proj.slug}`}
          style={{ color: 'var(--text-muted)' }}
        >
          ← project
        </Link>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {binding.parse_error && (
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
                {binding.parse_error}
              </pre>
            </CardBody>
          </Card>
        )}

        <ScriptCard
          orgSlug={org.slug}
          bindingId={binding.id}
          initial={binding.bash_content ?? ''}
        />

        {binding.parsed_meta && (
          <Card>
            <CardHeader>
              <CardTitle>Capability surface</CardTitle>
              <Badge tone="neutral">plane = {binding.parsed_meta.plane}</Badge>
            </CardHeader>
            <CardBody>
              <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
                Tools declared by this script, grouped by ring. Calling a tool via <Code>/mcp</Code>{' '}
                requires the listed capability on the access token (<Code>@&lt;env&gt;</Code> = the
                targeted host).
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {binding.parsed_meta.rings.map((ring, idx) => {
                  const tools = binding.parsed_meta!.tools.filter((t) => t.ring === ring);
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
                                bash:{ring}:{t.action}@&lt;env&gt;
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
        )}

        <HostsCard orgSlug={org.slug} bindingId={binding.id} hosts={hosts ?? []} />

        {binding.parsed_meta && (hosts ?? []).length > 0 && (
          <RunnerCard
            orgSlug={org.slug}
            bindingId={binding.id}
            tools={binding.parsed_meta.tools}
            hosts={(hosts ?? []).map((h) => ({
              host_slug: h.host_slug,
              host_address: h.host_address,
              ssh_user: h.ssh_user,
            }))}
          />
        )}
      </div>
    </main>
  );
}
