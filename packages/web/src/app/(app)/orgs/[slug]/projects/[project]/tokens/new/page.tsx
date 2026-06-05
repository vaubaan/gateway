'use client';

import { useEffect, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase/client';

interface RoleRow {
  id: string;
  name: string;
  provider: string;
  description: string | null;
}

export default function NewTokenPage({
  params,
}: {
  params: Promise<{ slug: string; project: string }>;
}) {
  const { slug: orgSlug, project: projectSlug } = usePromise(params);
  const [name, setName] = useState('');
  const [availableRoles, setAvailableRoles] = useState<RoleRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    void supabase
      .from('roles')
      .select('id, name, provider, description')
      .or('organization_id.is.null,organization_id.not.is.null')
      .order('name')
      .then((res) => {
        if (res.error) setError(res.error.message);
        else setAvailableRoles(res.data ?? []);
      });
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgSlug,
          projectSlug,
          name,
          roleIds: Array.from(selected),
        }),
      });
      const json = (await res.json()) as { api_key?: string; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setApiKey(json.api_key ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (apiKey) {
    return (
      <main>
        <h1>Access token created — copy this api_key now</h1>
        <div
          style={{
            padding: 24,
            border: '2px solid #ffae5e',
            borderRadius: 8,
            background: '#1a1408',
            marginTop: 24,
          }}
        >
          <p style={{ color: '#ffae5e', marginTop: 0 }}>
            ⚠️ This is the <strong>only time</strong> you&apos;ll see this api_key. After dismissing
            this page, only the prefix is retrievable.
          </p>
          <pre
            style={{
              padding: 16,
              background: '#000',
              borderRadius: 4,
              overflow: 'auto',
              fontSize: 14,
            }}
          >
            {apiKey}
          </pre>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(apiKey);
            }}
            style={{
              padding: '10px 14px',
              background: '#fff',
              color: '#000',
              border: 0,
              borderRadius: 6,
              marginRight: 8,
            }}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => router.push(`/orgs/${orgSlug}/projects/${projectSlug}`)}
            style={{
              padding: '10px 14px',
              background: 'transparent',
              color: '#fff',
              border: '1px solid #2a2a2a',
              borderRadius: 6,
            }}
          >
            Done — back to project
          </button>
        </div>
        <details style={{ marginTop: 24, opacity: 0.85 }}>
          <summary>Add to your `mcp.json`</summary>
          <pre
            style={{
              padding: 12,
              background: '#0c0c0c',
              borderRadius: 4,
              overflow: 'auto',
              fontSize: 13,
            }}
          >
            {`{
  "mcpServers": {
    "vauban": {
      "type": "http",
      "url": "${typeof window !== 'undefined' ? window.location.origin : 'https://vaubaan.com'}/mcp",
      "headers": {
        "Authorization": "Bearer ${apiKey}"
      }
    }
  }
}`}
          </pre>
        </details>
        <details style={{ marginTop: 12, opacity: 0.85 }}>
          <summary>Or add via Claude CLI</summary>
          <pre
            style={{
              padding: 12,
              background: '#0c0c0c',
              borderRadius: 4,
              overflow: 'auto',
              fontSize: 13,
            }}
          >
            {`claude mcp add --transport http ${projectSlug} ${typeof window !== 'undefined' ? window.location.origin : 'https://vaubaan.com'}/mcp --header "Authorization: Bearer ${apiKey}"`}
          </pre>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(
                `claude mcp add --transport http ${projectSlug} ${typeof window !== 'undefined' ? window.location.origin : 'https://vaubaan.com'}/mcp --header "Authorization: Bearer ${apiKey}"`,
              );
            }}
            style={{
              marginTop: 8,
              padding: '6px 12px',
              background: '#fff',
              color: '#000',
              border: 0,
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            Copy command
          </button>
        </details>
      </main>
    );
  }

  return (
    <main>
      <h1>New access token</h1>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12, maxWidth: 540 }}>
        <label>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>Token name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            pattern="^[a-z0-9](-?[a-z0-9])*$"
            required
            placeholder="ci-deploy"
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
        <fieldset style={{ border: '1px solid #2a2a2a', borderRadius: 6, padding: 12 }}>
          <legend style={{ opacity: 0.7 }}>Roles</legend>
          {availableRoles.map((r) => (
            <label key={r.id} style={{ display: 'block', padding: '6px 0' }}>
              <input
                type="checkbox"
                checked={selected.has(r.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(r.id);
                  else next.delete(r.id);
                  setSelected(next);
                }}
              />{' '}
              <strong>{r.name}</strong> <span style={{ opacity: 0.55 }}>{r.description}</span>
            </label>
          ))}
        </fieldset>
        <button
          type="submit"
          disabled={busy || selected.size === 0}
          style={{
            padding: '10px 14px',
            background: '#fff',
            color: '#000',
            border: 0,
            borderRadius: 6,
          }}
        >
          {busy ? 'Creating…' : 'Create access token'}
        </button>
        {error && <p style={{ color: '#ff7e7e' }}>{error}</p>}
      </form>
    </main>
  );
}
