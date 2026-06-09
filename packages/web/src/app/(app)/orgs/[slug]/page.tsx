import { LocalDate } from '@/components/LocalDate';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Button, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function OrgHomePage({ params }: { params: Promise<{ slug: string }> }) {
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

  const { data: projects } = await supabase
    .from('projects')
    .select('id, name, slug, created_at')
    .eq('organization_id', org.id)
    .order('created_at', { ascending: false })
    .returns<{ id: string; name: string; slug: string; created_at: string }[]>();

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
          <h1 style={{ margin: 0 }}>Projects</h1>
          <Code>
            /{org.slug} · {org.name}
          </Code>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>All projects</CardTitle>
          <Link href={`/orgs/${org.slug}/projects/new`}>
            <Button size="sm" variant="primary">
              + New project
            </Button>
          </Link>
        </CardHeader>
        <CardBody>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {(projects ?? []).map((proj) => {
              return (
                <li key={proj.id}>
                  <Link
                    href={`/orgs/${org.slug}/projects/${proj.slug}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      padding: 'var(--space-3) 0',
                      borderBottom: '1px solid var(--border-subtle)',
                      textDecoration: 'none',
                    }}
                  >
                    <span>
                      <strong>{proj.name}</strong>{' '}
                      <span style={{ color: 'var(--text-subtle)', marginLeft: 6 }}>
                        /{proj.slug}
                      </span>
                    </span>
                    <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-xs)' }}>
                      <LocalDate ts={proj.created_at} dateOnly /> · open →
                    </span>
                  </Link>
                </li>
              );
            })}
            {(projects ?? []).length === 0 && (
              <p style={{ color: 'var(--text-subtle)', margin: 0 }}>
                No projects yet. Create one to start binding cloud resources and issuing access
                tokens.
              </p>
            )}
          </ul>
        </CardBody>
      </Card>
    </main>
  );
}
