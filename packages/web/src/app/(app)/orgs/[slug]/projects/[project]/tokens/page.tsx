import { LocalDate } from '@/components/LocalDate';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface AccessTokenRow {
  id: string;
  name: string;
  api_key_prefix: string;
  status: string;
  last_used_at: string | null;
  created_at: string;
}

export default async function TokensIndex({
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

  const { data: tokens } = await supabase
    .from('access_tokens')
    .select('id, name, api_key_prefix, status, last_used_at, created_at')
    .eq('project_id', proj.id)
    .order('created_at', { ascending: false })
    .returns<AccessTokenRow[]>();

  return (
    <main>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 24,
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Access tokens</h1>
          <code style={{ opacity: 0.5 }}>
            /{org.slug}/{proj.slug}
          </code>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Link
            href={`/orgs/${org.slug}/projects/${proj.slug}/tokens/new`}
            style={{
              padding: '6px 12px',
              background: '#16a34a',
              color: 'white',
              border: '1px solid #15803d',
              borderRadius: 4,
              fontSize: 13,
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            + Mint token
          </Link>
          <Link href={`/orgs/${org.slug}/projects/${proj.slug}`} style={{ opacity: 0.7 }}>
            ← project
          </Link>
        </div>
      </header>

      <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
        {(tokens ?? []).map((t) => (
          <li
            key={t.id}
            style={{
              padding: 12,
              marginBottom: 8,
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <strong>{t.name}</strong>{' '}
              <code style={{ opacity: 0.55 }}>vbn_live_{t.api_key_prefix}…</code>
            </div>
            <span style={{ opacity: 0.55, fontSize: 13 }}>
              {t.status === 'active' ? (
                <span style={{ color: '#16a34a' }}>active</span>
              ) : (
                <span style={{ color: '#dc2626' }}>revoked</span>
              )}
              {t.last_used_at && (
                <span style={{ marginLeft: 8 }}>
                  used <LocalDate ts={t.last_used_at} />
                </span>
              )}
            </span>
          </li>
        ))}
        {(tokens ?? []).length === 0 && (
          <p style={{ opacity: 0.55 }}>
            No access tokens yet. Create one to mint API keys for this project.
          </p>
        )}
      </ul>
    </main>
  );
}
