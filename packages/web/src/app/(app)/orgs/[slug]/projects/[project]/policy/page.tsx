import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Code } from '@/components/ui';
import { PolicyControls, type PolicyRuleRow } from './policy-controls';

export const dynamic = 'force-dynamic';

export default async function PolicyPage({
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

  const { data: rules } = await supabase
    .from('policy_rules')
    .select('id, provider, plane, level, action, env_pattern, gate, priority')
    .eq('project_id', proj.id)
    .order('priority', { ascending: false })
    .returns<PolicyRuleRow[]>();

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
          <h1 style={{ margin: 0 }}>Policy rules</h1>
          <Code>
            /{org.slug}/{proj.slug}/policy
          </Code>
          <p
            style={{
              color: 'var(--text-muted)',
              marginTop: 'var(--space-2)',
              maxWidth: 720,
              fontSize: 'var(--text-sm)',
            }}
          >
            Default-deny allow-list — anything not matched by a rule is refused. Each rule resolves
            a mint request to one of{' '}
            <strong style={{ color: 'var(--accent-success-fg)' }}>allow</strong> (mint immediately),{' '}
            <strong style={{ color: 'var(--accent-warning-fg)' }}>confirm</strong> (open a
            Telegram/UI approval), or{' '}
            <strong style={{ color: 'var(--accent-danger-fg)' }}>deny</strong> (403, no override).
            Most-specific wins, ties broken by priority desc. Each project is seeded with{' '}
            <Code>*:*:*:read:* → allow</Code> and <Code>*:*:*:write:* → confirm</Code> at priority 0
            — add overrides like <Code>github:repo/code:write@feature/* → allow</Code> or{' '}
            <Code>*:*:access:write@* → deny</Code>.
          </p>
        </div>
        <Link
          href={`/orgs/${org.slug}/projects/${proj.slug}`}
          style={{ color: 'var(--text-muted)' }}
        >
          ← back
        </Link>
      </header>

      <PolicyControls rules={rules ?? []} projectId={proj.id} orgSlug={org.slug} />
    </main>
  );
}
