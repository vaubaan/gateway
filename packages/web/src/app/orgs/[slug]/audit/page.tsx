import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface AuditRow {
  id: string;
  ts: string;
  tool_name: string;
  decision: 'allowed' | 'denied';
  role_matched: string | null;
  denial_reason: string | null;
  upstream_latency_ms: number | null;
  bot_id: string | null;
}

export default async function AuditPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!org) notFound();
  const o = org;

  const { data: rows } = await supabase
    .from('audit_log')
    .select('id, ts, tool_name, decision, role_matched, denial_reason, upstream_latency_ms, bot_id')
    .eq('organization_id', o.id)
    .order('ts', { ascending: false })
    .limit(100);

  return (
    <main>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Audit log — {o.name}</h1>
        <Link href={`/orgs/${o.slug}`} style={{ opacity: 0.7 }}>
          ← back
        </Link>
      </header>
      <p style={{ opacity: 0.6 }}>Last 100 MCP calls. Retention 90 days.</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={th}>Time</th>
            <th style={th}>Tool</th>
            <th style={th}>Decision</th>
            <th style={th}>Role / reason</th>
            <th style={th}>Latency</th>
          </tr>
        </thead>
        <tbody>
          {((rows ?? []) as AuditRow[]).map((r) => (
            <tr key={r.id} style={{ borderBottom: '1px solid #2a2a2a' }}>
              <td style={td}>{new Date(r.ts).toLocaleString()}</td>
              <td style={td}>
                <code>{r.tool_name}</code>
              </td>
              <td
                style={{
                  ...td,
                  color: r.decision === 'allowed' ? '#7ee87e' : '#ff7e7e',
                }}
              >
                {r.decision}
              </td>
              <td style={{ ...td, opacity: 0.75, maxWidth: 480 }}>
                {r.role_matched ?? r.denial_reason}
              </td>
              <td style={td}>
                {r.upstream_latency_ms !== null ? `${r.upstream_latency_ms}ms` : '—'}
              </td>
            </tr>
          ))}
          {(rows ?? []).length === 0 && (
            <tr>
              <td colSpan={5} style={{ ...td, opacity: 0.5, textAlign: 'center', padding: 24 }}>
                No calls yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid #2a2a2a',
  opacity: 0.7,
  fontWeight: 500,
};

const td: React.CSSProperties = {
  padding: '8px 12px',
  verticalAlign: 'top',
};
