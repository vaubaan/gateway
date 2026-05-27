import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { RoleControls } from './role-controls';

export const dynamic = 'force-dynamic';

interface RuleView {
  effect: 'allow' | 'deny';
  target?: string;
  tool?: string;
  tool_matches?: string[];
  constraints?: Record<string, unknown>;
  priority?: number;
}

interface RoleRow {
  id: string;
  organization_id: string | null;
  provider: 'github' | 'vercel' | 'supabase';
  name: string;
  description: string | null;
  is_builtin: boolean;
  permissions: { version: number; rules: RuleView[] };
  created_at: string;
}

export default async function RoleDetailPage({
  params,
}: {
  params: Promise<{ slug: string; roleId: string }>;
}) {
  const { slug, roleId } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!org) notFound();

  const { data: row } = await supabase
    .from('roles')
    .select('*')
    .eq('id', roleId)
    .maybeSingle<RoleRow>();
  if (!row) notFound();

  // Visibility check : either builtin (organization_id null) or scoped to this org.
  if (row.organization_id !== null && row.organization_id !== org.id) notFound();

  return (
    <main>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{row.name}</h1>
          <code style={{ opacity: 0.5 }}>
            provider <strong>{row.provider}</strong> · {row.is_builtin ? 'builtin' : 'custom'}
          </code>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          {!row.is_builtin && (
            <>
              <Link
                href={`/orgs/${org.slug}/roles/${row.id}/edit`}
                style={{ opacity: 0.7, fontSize: 14 }}
              >
                Edit
              </Link>
              <RoleControls roleId={row.id} roleName={row.name} orgSlug={org.slug} />
            </>
          )}
          <Link href={`/orgs/${org.slug}/roles`} style={{ opacity: 0.7 }}>
            ← all roles
          </Link>
        </div>
      </header>

      {row.description && (
        <p style={{ marginTop: 16, opacity: 0.85, fontSize: 15, lineHeight: 1.6 }}>
          {row.description}
        </p>
      )}

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16 }}>
          Rules{' '}
          <span style={{ opacity: 0.5, fontWeight: 400 }}>
            ({row.permissions.rules.length} · evaluated top-to-bottom, deny overrides allow)
          </span>
        </h2>
        <ol style={{ listStyle: 'none', paddingLeft: 0, counterReset: 'rule' }}>
          {row.permissions.rules.map((rule, i) => (
            <RuleCard key={i} index={i + 1} rule={rule} />
          ))}
        </ol>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 16 }}>Raw JSON</h2>
        <pre
          style={{
            padding: 16,
            background: '#0c0c0c',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
            overflow: 'auto',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {JSON.stringify(row.permissions, null, 2)}
        </pre>
      </section>
    </main>
  );
}

function RuleCard({ index, rule }: { index: number; rule: RuleView }) {
  const isAllow = rule.effect === 'allow';
  return (
    <li
      style={{
        padding: 14,
        marginBottom: 10,
        border: '1px solid #2a2a2a',
        borderLeft: `3px solid ${isAllow ? '#7ee87e' : '#ff7e7e'}`,
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        <span style={{ opacity: 0.5, fontSize: 13 }}>rule #{index}</span>
        <strong style={{ color: isAllow ? '#7ee87e' : '#ff7e7e' }}>
          {rule.effect.toUpperCase()}
        </strong>
        {rule.tool && (
          <span>
            tool <code>{rule.tool}</code>
          </span>
        )}
        {rule.tool_matches && (
          <span>
            tools matching{' '}
            {rule.tool_matches.map((t) => (
              <code key={t} style={{ marginRight: 6 }}>
                {t}
              </code>
            ))}
          </span>
        )}
        {rule.target && rule.target !== '*' && (
          <span style={{ opacity: 0.75 }}>
            on <code>{rule.target}</code>
          </span>
        )}
        {rule.priority !== undefined && (
          <span style={{ opacity: 0.55, marginLeft: 'auto' }}>priority {rule.priority}</span>
        )}
      </div>
      {rule.constraints && Object.keys(rule.constraints).length > 0 && (
        <div style={{ marginTop: 10, paddingLeft: 16, borderLeft: '1px dashed #2a2a2a' }}>
          <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 4 }}>where</div>
          {Object.entries(rule.constraints).map(([path, c]) => (
            <div key={path} style={{ fontSize: 13, marginBottom: 4 }}>
              <code>{path}</code> {describeConstraint(c)}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function describeConstraint(c: unknown): string {
  if (typeof c !== 'object' || c === null) return '= ' + JSON.stringify(c);
  const obj = c as Record<string, unknown>;
  if ('equals' in obj) return `= ${JSON.stringify(obj.equals)}`;
  if ('in' in obj) return `∈ ${JSON.stringify(obj.in)}`;
  if ('not_in' in obj) return `∉ ${JSON.stringify(obj.not_in)}`;
  if ('match' in obj) return `matches ${JSON.stringify(obj.match)}`;
  if ('regex' in obj) return `~ /${String(obj.regex)}/`;
  if ('starts_with' in obj) return `starts with ${JSON.stringify(obj.starts_with)}`;
  if ('not_starts_with' in obj) return `does not start with ${JSON.stringify(obj.not_starts_with)}`;
  return JSON.stringify(obj);
}
