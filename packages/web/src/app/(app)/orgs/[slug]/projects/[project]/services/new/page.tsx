import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';
import { NewServiceForm } from './form';
import { RUNNER_TEMPLATE } from './template';

export const dynamic = 'force-dynamic';

export default async function NewServicePage({
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

  return (
    <main>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ margin: 0 }}>New service</h1>
        <Code>
          /{org.slug}/{proj.slug}/services/new
        </Code>{' '}
        ·{' '}
        <Link
          href={`/orgs/${org.slug}/projects/${proj.slug}/services`}
          style={{ color: 'var(--text-muted)' }}
        >
          ← services
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Annotated bash</CardTitle>
        </CardHeader>
        <CardBody>
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
            Paste a bash file with <Code>{`# @vaubaan-service:`}</Code> &amp;{' '}
            <Code>{`# @vaubaan: ring=X action=Y`}</Code> annotations. The parser will derive the
            service slug, ring list, and per-tool capabilities from the file itself ; the display
            name &amp; description below are operator-facing labels.
          </p>
          <NewServiceForm orgSlug={org.slug} projectSlug={proj.slug} template={RUNNER_TEMPLATE} />
        </CardBody>
      </Card>
    </main>
  );
}
