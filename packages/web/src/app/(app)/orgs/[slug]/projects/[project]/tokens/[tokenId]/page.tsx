import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { type Capability, formatCapability, isValidCapability } from '@vaubaan/shared';
import { getSupabaseServer } from '@/lib/supabase/server';
import { TokenControls } from './controls';

export const dynamic = 'force-dynamic';

interface TokenRow {
  id: string;
  name: string;
  api_key_prefix: string;
  status: 'active' | 'revoked';
  last_used_at: string | null;
  created_at: string;
  capabilities: unknown;
}

export default async function TokenPage({
  params,
}: {
  params: Promise<{ slug: string; project: string; tokenId: string }>;
}) {
  const { slug, project, tokenId } = await params;
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

  const { data: token } = await supabase
    .from('access_tokens')
    .select('id, name, api_key_prefix, status, last_used_at, created_at, capabilities')
    .eq('id', tokenId)
    .eq('project_id', proj.id)
    .maybeSingle<TokenRow>();
  if (!token) notFound();

  const { data: lastCalls } = await supabase
    .from('audit_log')
    .select('id, ts, tool_name, decision, capability_matched, upstream_latency_ms')
    .eq('access_token_id', token.id)
    .order('ts', { ascending: false })
    .limit(10);

  // Capabilities are stored as full tuples; surface them as shorthand strings.
  const capabilities: string[] = Array.isArray(token.capabilities)
    ? (token.capabilities as unknown[])
        .filter(
          (c): c is Capability =>
            typeof c === 'object' && c !== null && isValidCapability(c as Capability),
        )
        .map((c) => formatCapability(c))
    : [];

  return (
    <main>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{token.name}</h1>
          <code style={{ opacity: 0.5 }}>
            /{org.slug}/{proj.slug}/{token.name}
          </code>
        </div>
        <Link href={`/orgs/${org.slug}/projects/${proj.slug}`} style={{ opacity: 0.7 }}>
          ← back
        </Link>
      </header>

      <section style={{ marginTop: 24 }}>
        <p>
          <strong>API key prefix:</strong> <code>vbn_live_{token.api_key_prefix}…</code>{' '}
          {token.status === 'active' ? (
            <span style={{ color: '#7ee87e' }}>● active</span>
          ) : (
            <span style={{ color: '#ff7e7e' }}>● revoked</span>
          )}
        </p>
        {token.last_used_at && (
          <p style={{ opacity: 0.6, fontSize: 13 }}>
            Last call: {new Date(token.last_used_at).toLocaleString()}
          </p>
        )}
        <p style={{ opacity: 0.6, fontSize: 13 }}>
          Created: {new Date(token.created_at).toLocaleString()}
        </p>
      </section>

      <TokenControls
        tokenId={token.id}
        tokenName={token.name}
        tokenStatus={token.status}
        orgSlug={org.slug}
        projectSlug={proj.slug}
        capabilities={capabilities}
      />

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 16 }}>Recent calls</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={th}>Time</th>
              <th style={th}>Tool</th>
              <th style={th}>Decision</th>
              <th style={th}>Capability</th>
              <th style={th}>Latency</th>
            </tr>
          </thead>
          <tbody>
            {(
              (lastCalls ?? []) as Array<{
                id: string;
                ts: string;
                tool_name: string;
                decision: 'allowed' | 'denied';
                capability_matched: string | null;
                upstream_latency_ms: number | null;
              }>
            ).map((r) => (
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
                <td style={td}>{r.capability_matched ?? '—'}</td>
                <td style={td}>
                  {r.upstream_latency_ms !== null ? `${r.upstream_latency_ms}ms` : '—'}
                </td>
              </tr>
            ))}
            {(lastCalls ?? []).length === 0 && (
              <tr>
                <td colSpan={5} style={{ ...td, opacity: 0.5, textAlign: 'center' }}>
                  No calls yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
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
const td: React.CSSProperties = { padding: '8px 12px' };
