import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';

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
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{o.name}</h1>
          <code style={{ opacity: 0.5 }}>/{o.slug}</code>
        </div>
        <Link href="/dashboard" style={{ opacity: 0.7 }}>
          ← all orgs
        </Link>
      </header>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18 }}>Cloud providers</h2>
        <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
          {(['github', 'vercel', 'supabase'] as const).map((p) => {
            const row = (providers ?? []).find(
              (x) => (x as { provider: string }).provider === p,
            ) as { status: string; connected_at: string } | undefined;
            return (
              <li
                key={p}
                style={{
                  padding: 12,
                  marginBottom: 8,
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>
                  <strong>{p}</strong>{' '}
                  <span style={{ opacity: 0.55 }}>
                    {row
                      ? `connected ${new Date(row.connected_at).toLocaleDateString()}`
                      : 'not connected'}
                  </span>
                </span>
                {row ? (
                  <span style={{ color: row.status === 'connected' ? '#7ee87e' : '#ff7e7e' }}>
                    {row.status}
                  </span>
                ) : p === 'github' ? (
                  <Link
                    href={`/orgs/${o.slug}/providers/github/connect`}
                    style={{
                      padding: '6px 10px',
                      background: '#fff',
                      color: '#000',
                      borderRadius: 4,
                      textDecoration: 'none',
                    }}
                  >
                    Connect
                  </Link>
                ) : (
                  <span style={{ opacity: 0.4 }}>phase 5</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section style={{ marginTop: 32 }}>
        <header
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
        >
          <h2 style={{ fontSize: 18 }}>Projects</h2>
          <Link
            href={`/orgs/${o.slug}/projects/new`}
            style={{
              padding: '6px 10px',
              background: '#fff',
              color: '#000',
              borderRadius: 4,
              textDecoration: 'none',
            }}
          >
            + New project
          </Link>
        </header>
        <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
          {(projects ?? []).map((p) => {
            const proj = p as { id: string; name: string; slug: string };
            return (
              <li
                key={proj.id}
                style={{
                  padding: 12,
                  marginBottom: 8,
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                }}
              >
                <Link
                  href={`/orgs/${o.slug}/projects/${proj.slug}`}
                  style={{ textDecoration: 'none' }}
                >
                  <strong>{proj.name}</strong> <span style={{ opacity: 0.55 }}>/{proj.slug}</span>
                </Link>
              </li>
            );
          })}
          {(projects ?? []).length === 0 && <p style={{ opacity: 0.55 }}>No projects yet.</p>}
        </ul>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18 }}>Audit log</h2>
        <Link href={`/orgs/${o.slug}/audit`}>View recent calls →</Link>
      </section>
    </main>
  );
}
