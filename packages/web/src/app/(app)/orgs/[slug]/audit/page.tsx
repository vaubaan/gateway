import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Select,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

interface AuditRow {
  id: string;
  ts: string;
  tool_name: string;
  decision: 'allowed' | 'denied';
  role_matched: string | null;
  denial_reason: string | null;
  upstream_latency_ms: number | null;
  access_token_id: string | null;
}

interface TokenOpt {
  id: string;
  name: string;
}

interface SearchParams {
  token?: string;
  decision?: 'allowed' | 'denied';
  since?: string;
}

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!org) notFound();

  // Access tokens for the filter dropdown.
  const { data: tokens } = await supabase
    .from('access_tokens')
    .select('id, name, projects!inner(organization_id)')
    .eq('projects.organization_id', org.id);
  const tokenOpts: TokenOpt[] = ((tokens ?? []) as Array<{ id: string; name: string }>).map(
    (t) => ({ id: t.id, name: t.name }),
  );

  // Last 7 days stats.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  let statQ = supabase
    .from('audit_log')
    .select('decision, tool_name', { count: 'exact' })
    .eq('organization_id', org.id)
    .gte('ts', sevenDaysAgo);
  if (sp.token) statQ = statQ.eq('access_token_id', sp.token);
  if (sp.decision) statQ = statQ.eq('decision', sp.decision);
  const statResp = await statQ.limit(5000);
  const statRows = (statResp.data ?? []) as Array<{
    decision: 'allowed' | 'denied';
    tool_name: string;
  }>;
  const allowed7d = statRows.filter((r) => r.decision === 'allowed').length;
  const denied7d = statRows.filter((r) => r.decision === 'denied').length;
  const topTools = topN(
    statRows.reduce<Record<string, number>>((acc, r) => {
      acc[r.tool_name] = (acc[r.tool_name] ?? 0) + 1;
      return acc;
    }, {}),
    5,
  );

  // Filtered list.
  let q = supabase
    .from('audit_log')
    .select(
      'id, ts, tool_name, decision, role_matched, denial_reason, upstream_latency_ms, access_token_id',
    )
    .eq('organization_id', org.id)
    .order('ts', { ascending: false })
    .limit(100);
  if (sp.token) q = q.eq('access_token_id', sp.token);
  if (sp.decision) q = q.eq('decision', sp.decision);
  if (sp.since) q = q.gte('ts', sp.since);
  const { data: rows } = await q;
  const auditRows = (rows ?? []) as AuditRow[];

  const tokenNameById = new Map(tokenOpts.map((t) => [t.id, t.name]));

  return (
    <main>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 'var(--space-4)',
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Audit log</h1>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            {org.name} · last 100 calls · 90-day retention
          </p>
        </div>
        <Link href={`/orgs/${org.slug}`} style={{ color: 'var(--text-muted)' }}>
          ← back
        </Link>
      </header>

      {/* Stats row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-4)',
        }}
      >
        <Card>
          <CardBody>
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
              Allowed (7d)
            </div>
            <div
              style={{
                fontSize: 'var(--text-2xl)',
                fontWeight: 'var(--font-weight-semibold)',
                color: 'var(--accent-success-fg)',
              }}
            >
              {allowed7d}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
              Denied (7d)
            </div>
            <div
              style={{
                fontSize: 'var(--text-2xl)',
                fontWeight: 'var(--font-weight-semibold)',
                color: 'var(--accent-danger-fg)',
              }}
            >
              {denied7d}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top tools (7d)</CardTitle>
          </CardHeader>
          <CardBody>
            {topTools.length === 0 ? (
              <p style={{ color: 'var(--text-subtle)', margin: 0 }}>No calls yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 'var(--text-sm)' }}>
                {topTools.map(([name, n]) => (
                  <li
                    key={name}
                    style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}
                  >
                    <Code>{name}</Code>
                    <span style={{ color: 'var(--text-muted)' }}>{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Filters */}
      <form
        method="get"
        style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}
      >
        <Select name="token" defaultValue={sp.token ?? ''} style={{ width: 'auto' }}>
          <option value="">All access tokens</option>
          {tokenOpts.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select name="decision" defaultValue={sp.decision ?? ''} style={{ width: 'auto' }}>
          <option value="">All decisions</option>
          <option value="allowed">allowed</option>
          <option value="denied">denied</option>
        </Select>
        <button
          type="submit"
          style={{
            padding: '8px 14px',
            background: 'var(--primary-bg)',
            color: 'var(--primary-fg)',
            border: 0,
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            fontSize: 'var(--text-base)',
          }}
        >
          Apply
        </button>
        {(sp.token || sp.decision) && (
          <a
            href={`/orgs/${org.slug}/audit`}
            style={{
              padding: '8px 14px',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-base)',
              color: 'var(--text-muted)',
            }}
          >
            Clear
          </a>
        )}
      </form>

      <Card>
        <Table>
          <Thead>
            <Tr>
              <Th>Time</Th>
              <Th>Access token</Th>
              <Th>Tool</Th>
              <Th>Decision</Th>
              <Th>Role / reason</Th>
              <Th>Latency</Th>
            </Tr>
          </Thead>
          <Tbody>
            {auditRows.map((r) => (
              <Tr key={r.id}>
                <Td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {new Date(r.ts).toLocaleString()}
                </Td>
                <Td>{r.access_token_id ? (tokenNameById.get(r.access_token_id) ?? '—') : '—'}</Td>
                <Td>
                  <Code>{r.tool_name}</Code>
                </Td>
                <Td>
                  <Badge tone={r.decision === 'allowed' ? 'success' : 'danger'}>{r.decision}</Badge>
                </Td>
                <Td style={{ maxWidth: 480, color: 'var(--text-muted)' }}>
                  {r.role_matched ?? r.denial_reason}
                </Td>
                <Td style={{ color: 'var(--text-muted)' }}>
                  {r.upstream_latency_ms !== null ? `${r.upstream_latency_ms} ms` : '—'}
                </Td>
              </Tr>
            ))}
            {auditRows.length === 0 && (
              <Tr>
                <Td colSpan={6} style={{ color: 'var(--text-subtle)', textAlign: 'center' }}>
                  No calls match these filters.
                </Td>
              </Tr>
            )}
          </Tbody>
        </Table>
      </Card>
    </main>
  );
}

function topN(map: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}
