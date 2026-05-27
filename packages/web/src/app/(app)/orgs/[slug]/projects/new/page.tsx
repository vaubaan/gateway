'use client';

import { useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase/client';

export default function NewProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: orgSlug } = usePromise(params);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      const { data: org } = await supabase
        .from('organizations')
        .select('id')
        .eq('slug', orgSlug)
        .single<{ id: string }>();
      if (!org) throw new Error('org not found');
      const { data: user } = await supabase.auth.getUser();
      const { error: err } = await supabase.from('projects').insert({
        organization_id: org.id,
        name,
        slug,
        created_by: user.user?.id ?? null,
      });
      if (err) throw err;
      // refresh() so the (app) layout re-fetches the projects list driving the
      // sidebar "pick a project" dropdown. Without it, the new project doesn't
      // appear in the picker until the next full reload.
      router.refresh();
      router.push(`/orgs/${orgSlug}/projects/${slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>New project</h1>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
        <label>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>Name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={{
              width: '100%',
              padding: 10,
              background: '#1a1a1a',
              color: '#fff',
              border: '1px solid #2a2a2a',
              borderRadius: 6,
            }}
          />
        </label>
        <label>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>Slug</div>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            pattern="^[a-z0-9](-?[a-z0-9])*$"
            required
            style={{
              width: '100%',
              padding: 10,
              background: '#1a1a1a',
              color: '#fff',
              border: '1px solid #2a2a2a',
              borderRadius: 6,
            }}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          style={{
            padding: '10px 14px',
            background: '#fff',
            color: '#000',
            border: 0,
            borderRadius: 6,
          }}
        >
          {busy ? 'Creating…' : 'Create project'}
        </button>
        {error && <p style={{ color: '#ff7e7e' }}>{error}</p>}
      </form>
    </main>
  );
}
