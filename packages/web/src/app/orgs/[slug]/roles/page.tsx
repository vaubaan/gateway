import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface RoleRow {
  id: string;
  organization_id: string | null;
  provider: 'github' | 'vercel' | 'supabase';
  name: string;
  description: string | null;
  is_builtin: boolean;
  permissions: { version: number; rules: unknown[] };
}

export default async function RolesPage({ params }: { params: Promise<{ slug: string }> }) {
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

  // Builtins (organization_id is null) + custom roles of this org.
  const { data: rows } = await supabase
    .from('roles')
    .select('id, organization_id, provider, name, description, is_builtin, permissions')
    .or(`organization_id.is.null,organization_id.eq.${org.id}`)
    .order('provider')
    .order('name');
  const roles = (rows ?? []) as unknown as RoleRow[];

  const byProvider: Record<string, RoleRow[]> = {};
  for (const r of roles) (byProvider[r.provider] ??= []).push(r);

  return (
    <main>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Roles — {org.name}</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <Link
            href={`/orgs/${org.slug}/roles/new`}
            style={{
              padding: '6px 10px',
              background: '#fff',
              color: '#000',
              borderRadius: 4,
              textDecoration: 'none',
              fontSize: 13,
            }}
          >
            + New custom role
          </Link>
          <Link href={`/orgs/${org.slug}`} style={{ opacity: 0.7 }}>
            ← back
          </Link>
        </div>
      </header>
      <p style={{ opacity: 0.6 }}>
        Builtin roles are read-only and apply to every Vaubaan org. Custom roles are scoped to this
        org and editable.
      </p>

      {(['github', 'vercel', 'supabase'] as const).map((provider) => {
        const items = byProvider[provider] ?? [];
        return (
          <section key={provider} style={{ marginTop: 32 }}>
            <h2 style={{ fontSize: 18, opacity: 0.85, textTransform: 'capitalize' }}>{provider}</h2>
            {items.length === 0 && <p style={{ opacity: 0.5 }}>No roles for this provider yet.</p>}
            <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
              {items.map((r) => (
                <li
                  key={r.id}
                  style={{
                    padding: 12,
                    marginBottom: 8,
                    border: '1px solid #2a2a2a',
                    borderRadius: 6,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Link
                      href={`/orgs/${org.slug}/roles/${r.id}`}
                      style={{ textDecoration: 'none' }}
                    >
                      <strong>{r.name}</strong>
                      <span style={{ opacity: 0.55, marginLeft: 8 }}>
                        {r.permissions.rules.length} rule
                        {r.permissions.rules.length === 1 ? '' : 's'}
                      </span>
                    </Link>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ opacity: 0.5 }}>{r.is_builtin ? 'builtin' : 'custom'}</span>
                      {!r.is_builtin && (
                        <Link
                          href={`/orgs/${org.slug}/roles/${r.id}/edit`}
                          style={{ opacity: 0.7, fontSize: 13 }}
                        >
                          Edit
                        </Link>
                      )}
                    </span>
                  </div>
                  {r.description && (
                    <p style={{ margin: '6px 0 0', opacity: 0.75, fontSize: 14 }}>
                      {r.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}
