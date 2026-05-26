'use client';

import { useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase/client';

export default function NewBindingPage({
  params,
}: {
  params: Promise<{ slug: string; project: string }>;
}) {
  const { slug: orgSlug, project: projectSlug } = usePromise(params);
  const [provider, setProvider] = useState<'github' | 'vercel' | 'supabase'>('github');
  const [resourceRef, setResourceRef] = useState('');
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
      const { data: proj } = await supabase
        .from('projects')
        .select('id')
        .eq('organization_id', org.id)
        .eq('slug', projectSlug)
        .single<{ id: string }>();
      if (!proj) throw new Error('project not found');
      const { error: err } = await supabase.from('provider_bindings').insert({
        project_id: proj.id,
        provider,
        resource_ref: resourceRef,
        display_name: resourceRef,
      });
      if (err) throw err;
      router.push(`/orgs/${orgSlug}/projects/${projectSlug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Bind a resource</h1>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
        <label>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>Provider</div>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
            style={{
              width: '100%',
              padding: 10,
              background: '#1a1a1a',
              color: '#fff',
              border: '1px solid #2a2a2a',
              borderRadius: 6,
            }}
          >
            <option value="github">github</option>
            <option value="vercel" disabled>
              vercel (phase 5)
            </option>
            <option value="supabase" disabled>
              supabase (phase 5)
            </option>
          </select>
        </label>
        <label>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>
            Resource ref{' '}
            <span style={{ opacity: 0.55 }}>
              {provider === 'github'
                ? '(owner/repo)'
                : provider === 'vercel'
                  ? '(prj_xxx)'
                  : '(<project_ref>)'}
            </span>
          </div>
          <input
            value={resourceRef}
            onChange={(e) => setResourceRef(e.target.value)}
            required
            placeholder={provider === 'github' ? 'acme/website' : ''}
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
          {busy ? 'Saving…' : 'Save binding'}
        </button>
        {error && <p style={{ color: '#ff7e7e' }}>{error}</p>}
      </form>
    </main>
  );
}
