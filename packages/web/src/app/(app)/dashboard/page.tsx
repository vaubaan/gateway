import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface OrgRow {
  role: 'member' | 'admin';
  organization: { id: string; slug: string; name: string };
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
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-6)',
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Organizations</h1>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            Each org is a tenant. Bots, projects, audit log live under one.
          </p>
        </div>
        <Link href="/orgs/new">
          <Button variant="primary">+ New organization</Button>
        </Link>
      </header>
      {error && (
        <p style={{ color: 'var(--accent-danger-fg)' }}>Error loading orgs: {error.message}</p>
      )}
      {(rows ?? []).length === 0 && !error && (
        <Card>
          <CardBody>
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>
              You don&apos;t belong to any organization yet. Create one to get started.
            </p>
          </CardBody>
        </Card>
      )}
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {((rows ?? []) as unknown as OrgRow[]).map((r) => (
          <Link
            key={r.organization.id}
            href={`/orgs/${r.organization.slug}`}
            style={{ display: 'block' }}
          >
            <Card>
              <CardHeader>
                <CardTitle>
                  {r.organization.name}{' '}
                  <span style={{ color: 'var(--text-subtle)', fontWeight: 400 }}>
                    /{r.organization.slug}
                  </span>
                </CardTitle>
                <Badge tone={r.role === 'admin' ? 'info' : 'neutral'}>{r.role}</Badge>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
