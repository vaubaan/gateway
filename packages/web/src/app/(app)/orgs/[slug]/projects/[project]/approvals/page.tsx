import { LocalDate } from '@/components/LocalDate';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { type Capability, formatCapability, isValidCapability } from '@vaubaan/shared';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Badge, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';
import { ApprovalControls } from './approval-controls';

export const dynamic = 'force-dynamic';

interface ApprovalRow {
  id: string;
  status: string;
  channel: string;
  requested_capabilities: unknown;
  requested_token_name: string;
  requested_ttl_hours: number;
  requested_single_use: boolean;
  context: unknown;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export default async function ApprovalsPage({
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

  const { data: pending } = await supabase
    .from('approval_requests')
    .select(
      'id, status, channel, requested_capabilities, requested_token_name, requested_ttl_hours, requested_single_use, context, created_at, expires_at, decided_at, decided_by',
    )
    .eq('project_id', proj.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .returns<ApprovalRow[]>();
  const { data: recent } = await supabase
    .from('approval_requests')
    .select(
      'id, status, channel, requested_capabilities, requested_token_name, requested_ttl_hours, requested_single_use, context, created_at, expires_at, decided_at, decided_by',
    )
    .eq('project_id', proj.id)
    .neq('status', 'pending')
    .order('decided_at', { ascending: false, nullsFirst: false })
    .limit(20)
    .returns<ApprovalRow[]>();

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
          <h1 style={{ margin: 0 }}>Approvals</h1>
          <Code>
            /{org.slug}/{proj.slug}/approvals
          </Code>
          <p
            style={{
              color: 'var(--text-muted)',
              marginTop: 'var(--space-2)',
              maxWidth: 720,
              fontSize: 'var(--text-sm)',
            }}
          >
            Pending mint requests held behind human approval. Approving mints the access token now ;
            the original caller picks up the api_key by polling{' '}
            <Code>/api/v1/mgmt/tokens/pending/&lt;approval_id&gt;</Code>. TTL 15 min.
          </p>
        </div>
        <Link
          href={`/orgs/${org.slug}/projects/${proj.slug}`}
          style={{ color: 'var(--text-muted)' }}
        >
          ← back
        </Link>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Card>
          <CardHeader>
            <CardTitle>Pending ({(pending ?? []).length})</CardTitle>
          </CardHeader>
          <CardBody>
            {(pending ?? []).length === 0 ? (
              <p style={{ color: 'var(--text-subtle)', margin: 0 }}>Nothing pending.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {(pending ?? []).map((a) => (
                  <li
                    key={a.id}
                    style={{
                      padding: 'var(--space-3) 0',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                        marginBottom: 'var(--space-2)',
                      }}
                    >
                      <span>
                        <strong>{a.requested_token_name}</strong>{' '}
                        <Badge tone="info">{a.channel}</Badge>{' '}
                        {a.requested_single_use && <Badge tone="warning">single-use</Badge>}{' '}
                        <span style={{ color: 'var(--text-subtle)', fontSize: 13 }}>
                          ttl {a.requested_ttl_hours}h · expires <LocalDate ts={a.expires_at} />
                        </span>
                      </span>
                      <ApprovalControls projectId={proj.id} approvalId={a.id} orgSlug={org.slug} />
                    </div>
                    <ul
                      style={{
                        listStyle: 'none',
                        padding: 0,
                        margin: 0,
                        fontSize: 13,
                      }}
                    >
                      {capArray(a.requested_capabilities).map((c) => (
                        <li key={formatCapability(c)} style={{ color: 'var(--text-muted)' }}>
                          • <Code>{formatCapability(c)}</Code>
                        </li>
                      ))}
                    </ul>
                    {a.context !== null && (
                      <pre
                        style={{
                          marginTop: 'var(--space-2)',
                          padding: 'var(--space-2)',
                          background: 'var(--surface-base)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 'var(--radius-md)',
                          fontSize: 12,
                          maxHeight: 160,
                          overflow: 'auto',
                        }}
                      >
                        {JSON.stringify(a.context, null, 2)}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recently decided</CardTitle>
          </CardHeader>
          <CardBody>
            {(recent ?? []).length === 0 ? (
              <p style={{ color: 'var(--text-subtle)', margin: 0 }}>No history yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {(recent ?? []).map((a) => (
                  <li
                    key={a.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      padding: 'var(--space-2) 0',
                      borderBottom: '1px solid var(--border-subtle)',
                      fontSize: 13,
                    }}
                  >
                    <span>
                      <Badge
                        tone={
                          a.status === 'approved' || a.status === 'consumed'
                            ? 'success'
                            : a.status === 'denied'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {a.status}
                      </Badge>{' '}
                      <strong>{a.requested_token_name}</strong>{' '}
                      <span style={{ color: 'var(--text-subtle)' }}>
                        via {a.channel}
                        {a.decided_by ? ` · ${a.decided_by}` : ''}
                      </span>
                    </span>
                    <span style={{ color: 'var(--text-subtle)' }}>
                      {a.decided_at ? <LocalDate ts={a.decided_at} /> : '—'}
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

function capArray(input: unknown): Capability[] {
  if (!Array.isArray(input)) return [];
  return (input as unknown[]).filter(
    (c): c is Capability =>
      typeof c === 'object' && c !== null && isValidCapability(c as Capability),
  );
}
