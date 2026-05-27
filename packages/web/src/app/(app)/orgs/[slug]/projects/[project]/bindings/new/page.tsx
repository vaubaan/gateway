import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { PROVIDERS } from '@vaubaan/shared';
import { getSupabaseServer } from '@/lib/supabase/server';
import { loadProviderState } from '@/lib/providers/state';
import { Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';
import { BindingForm } from './binding-form';

export const dynamic = 'force-dynamic';

export default async function NewBindingPage({
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

  const states = await Promise.all(PROVIDERS.map((p) => loadProviderState(org.id, p)));

  const connected = states.filter((s) => s.status === 'connected');
  const offered = connected.map((s) => ({
    provider: s.provider,
    resources: s.resources,
    error: s.error,
  }));

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
          <h1 style={{ margin: 0 }}>Bind a resource</h1>
          <Code>
            /{org.slug}/{proj.slug}
          </Code>
        </div>
        <Link
          href={`/orgs/${org.slug}/projects/${proj.slug}`}
          style={{ color: 'var(--text-muted)' }}
        >
          ← back
        </Link>
      </header>

      {connected.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No providers connected</CardTitle>
          </CardHeader>
          <CardBody>
            <p style={{ color: 'var(--text-muted)' }}>
              Connect at least one provider on the{' '}
              <Link href={`/orgs/${org.slug}/providers`}>Cloud providers</Link> page before binding
              resources to this project.
            </p>
          </CardBody>
        </Card>
      ) : (
        <BindingForm
          orgSlug={org.slug}
          projectId={proj.id}
          projectSlug={proj.slug}
          offered={offered}
        />
      )}
    </main>
  );
}
