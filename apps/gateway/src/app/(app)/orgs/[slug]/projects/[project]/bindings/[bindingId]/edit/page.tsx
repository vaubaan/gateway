import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { PROVIDERS } from '@vaubaan/shared';
import type { Provider } from '@vaubaan/shared';
import { getSupabaseServer } from '@/lib/supabase/server';
import { loadProviderState } from '@/lib/providers/state';
import { Code } from '@/components/ui';
import { BindingForm, type BindingInitial } from '../../new/binding-form';

export const dynamic = 'force-dynamic';

interface BindingRow {
  id: string;
  provider: Provider;
  resource_ref: string;
  display_name: string | null;
  environment: string | null;
  env_less_exclude_branch: string | null;
  env_less_exclude_protected: boolean;
}

export default async function EditBindingPage({
  params,
}: {
  params: Promise<{ slug: string; project: string; bindingId: string }>;
}) {
  const { slug, project, bindingId } = await params;
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

  const { data: binding } = await supabase
    .from('provider_bindings')
    .select(
      'id, provider, resource_ref, display_name, environment, env_less_exclude_branch, env_less_exclude_protected',
    )
    .eq('id', bindingId)
    .eq('project_id', proj.id)
    .maybeSingle<BindingRow>();
  if (!binding || binding.provider === 'bash') notFound();

  const states = await Promise.all(PROVIDERS.map((p) => loadProviderState(org.id, p)));
  const connected = states.filter((s) => s.status === 'connected');
  const offered = connected.map((s) => ({
    provider: s.provider,
    resources: s.resources,
    error: s.error,
  }));

  const initial: BindingInitial = {
    bindingId: binding.id,
    provider: binding.provider,
    resource_ref: binding.resource_ref,
    environment: binding.environment,
    env_less_exclude_branch: binding.env_less_exclude_branch,
    env_less_exclude_protected: binding.env_less_exclude_protected,
  };

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
          <h1 style={{ margin: 0 }}>Edit binding</h1>
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

      <BindingForm
        orgSlug={org.slug}
        projectId={proj.id}
        projectSlug={proj.slug}
        offered={offered}
        initial={initial}
      />
    </main>
  );
}
