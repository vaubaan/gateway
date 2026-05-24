import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { BindingDeleteButton } from './binding-delete';
import { ProjectControls } from './project-controls';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({
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
  const o = org;

  const { data: proj } = await supabase
    .from('projects')
    .select('id, slug, name')
    .eq('organization_id', o.id)
    .eq('slug', project)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!proj) notFound();
  const p = proj;

  const [{ data: bindings }, { data: bots }] = await Promise.all([
    supabase.from('provider_bindings').select('*').eq('project_id', p.id),
    supabase
      .from('bots')
      .select('*')
      .eq('project_id', p.id)
      .order('created_at', { ascending: false }),
  ]);

  return (
    <main>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{p.name}</h1>
          <code style={{ opacity: 0.5 }}>
            /{o.slug}/{p.slug}
          </code>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <ProjectControls projectId={p.id} initialName={p.name} orgSlug={o.slug} />
          <Link href={`/orgs/${o.slug}`} style={{ opacity: 0.7 }}>
            ← back
          </Link>
        </div>
      </header>

      <section style={{ marginTop: 32 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 18 }}>Provider bindings</h2>
          <Link
            href={`/orgs/${o.slug}/projects/${p.slug}/bindings/new`}
            style={{
              padding: '6px 10px',
              background: '#fff',
              color: '#000',
              borderRadius: 4,
              textDecoration: 'none',
            }}
          >
            + Bind a resource
          </Link>
        </header>
        <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
          {(bindings ?? []).map((b) => {
            const bind = b as { id: string; provider: string; resource_ref: string };
            return (
              <li
                key={bind.id}
                style={{
                  padding: 12,
                  marginBottom: 8,
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>
                  <strong>{bind.provider}</strong>{' '}
                  <code style={{ opacity: 0.7 }}>{bind.resource_ref}</code>
                </span>
                <BindingDeleteButton bindingId={bind.id} orgSlug={o.slug} />
              </li>
            );
          })}
          {(bindings ?? []).length === 0 && <p style={{ opacity: 0.55 }}>No bindings yet.</p>}
        </ul>
      </section>

      <section style={{ marginTop: 32 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 18 }}>Bots</h2>
          <Link
            href={`/orgs/${o.slug}/projects/${p.slug}/bots/new`}
            style={{
              padding: '6px 10px',
              background: '#fff',
              color: '#000',
              borderRadius: 4,
              textDecoration: 'none',
            }}
          >
            + New bot
          </Link>
        </header>
        <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
          {(bots ?? []).map((b) => {
            const bot = b as {
              id: string;
              name: string;
              api_key_prefix: string;
              status: string;
              last_used_at: string | null;
            };
            return (
              <li
                key={bot.id}
                style={{
                  padding: 12,
                  marginBottom: 8,
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <Link
                  href={`/orgs/${o.slug}/projects/${p.slug}/bots/${bot.id}`}
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  <strong>{bot.name}</strong>{' '}
                  <code style={{ opacity: 0.55 }}>vbn_live_{bot.api_key_prefix}…</code>
                </Link>
                <span style={{ opacity: 0.55 }}>
                  {bot.status === 'active' ? (
                    <span style={{ color: '#7ee87e' }}>active</span>
                  ) : (
                    <span style={{ color: '#ff7e7e' }}>revoked</span>
                  )}
                  {bot.last_used_at && (
                    <span style={{ marginLeft: 8 }}>
                      used {new Date(bot.last_used_at).toLocaleString()}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
          {(bots ?? []).length === 0 && <p style={{ opacity: 0.55 }}>No bots yet.</p>}
        </ul>
      </section>
    </main>
  );
}
