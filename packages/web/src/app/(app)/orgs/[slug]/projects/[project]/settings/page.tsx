import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Code } from '@/components/ui';
import { ProjectControls } from '../project-controls';

export const dynamic = 'force-dynamic';

export default async function ProjectSettingsPage({
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
        <h1 style={{ margin: 0 }}>Project settings</h1>
        <Code>
          /{org.slug}/{proj.slug}
        </Code>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <ProjectControls
          projectId={proj.id}
          initialName={proj.name}
          initialSlug={proj.slug}
          orgSlug={org.slug}
        />
      </div>
    </main>
  );
}
