import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { NewTokenForm } from './new-token-form';

export const dynamic = 'force-dynamic';

interface BindingRow {
  provider: string;
  resource_ref: string;
  environment: string | null;
}

interface SshHostRow {
  host_slug: string;
}

export default async function NewTokenPage({
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
    .select('id, slug')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string }>();
  if (!org) notFound();

  const { data: proj } = await supabase
    .from('projects')
    .select('id, slug')
    .eq('organization_id', org.id)
    .eq('slug', project)
    .maybeSingle<{ id: string; slug: string }>();
  if (!proj) notFound();

  const [{ data: bindings }, { data: sshHostsRows }] = await Promise.all([
    supabase
      .from('provider_bindings')
      .select('provider, resource_ref, environment')
      .eq('project_id', proj.id)
      .returns<BindingRow[]>(),
    supabase
      .from('ssh_bindings')
      .select('host_slug')
      .eq('project_id', proj.id)
      .returns<SshHostRow[]>(),
  ]);

  return (
    <NewTokenForm
      orgSlug={org.slug}
      projectSlug={proj.slug}
      bindings={{
        rows: bindings ?? [],
        sshHosts: (sshHostsRows ?? []).map((r) => r.host_slug),
      }}
    />
  );
}
