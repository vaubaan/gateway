import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface OrgRow {
  organization: { id: string; slug: string; name: string };
  role: 'member' | 'admin';
}

export default async function DashboardPage() {
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: rows, error } = await supabase
    .from('org_members')
    .select('role, organization:organizations(id, slug, name)')
    .order('added_at');

  return (
    <main>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Your organizations</h1>
        <span style={{ opacity: 0.6 }}>{user.user.email}</span>
      </header>
      <p>
        <Link href="/orgs/new">
          <button
            type="button"
            style={{
              padding: '8px 12px',
              background: '#fff',
              color: '#000',
              border: 0,
              borderRadius: 6,
            }}
          >
            + New organization
          </button>
        </Link>
      </p>
      {error && <p style={{ color: '#ff7e7e' }}>Error loading orgs: {error.message}</p>}
      {(rows ?? []).length === 0 && !error && (
        <p style={{ opacity: 0.6 }}>You don&apos;t belong to any organization yet.</p>
      )}
      <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
        {((rows ?? []) as unknown as OrgRow[]).map((r) => (
          <li
            key={r.organization.id}
            style={{
              padding: 12,
              border: '1px solid #2a2a2a',
              borderRadius: 6,
              marginBottom: 8,
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <Link href={`/orgs/${r.organization.slug}`} style={{ textDecoration: 'none' }}>
              <strong>{r.organization.name}</strong>
              <span style={{ opacity: 0.55, marginLeft: 8 }}>/{r.organization.slug}</span>
            </Link>
            <span style={{ opacity: 0.5 }}>{r.role}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
