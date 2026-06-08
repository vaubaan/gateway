'use client';

import { useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import { parseCapability } from '@vaubaan/shared/capability';
import { CAPABILITY_PRESETS } from '@/lib/capabilities/presets';

export default function NewTokenPage({
  params,
}: {
  params: Promise<{ slug: string; project: string }>;
}) {
  const { slug: orgSlug, project: projectSlug } = usePromise(params);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<string[]>([]);
  const [customInput, setCustomInput] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const router = useRouter();

  const capabilities = [...Array.from(selected), ...extra];

  function addCustom() {
    const value = customInput.trim();
    if (!value) return;
    try {
      parseCapability(value); // validate shorthand grammar before accepting
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : 'invalid capability');
      return;
    }
    if (!selected.has(value) && !extra.includes(value)) {
      setExtra((cur) => [...cur, value]);
    }
    setCustomInput('');
    setCustomError(null);
  }

  function removeExtra(value: string) {
    setExtra((cur) => cur.filter((v) => v !== value));
  }

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
          capabilities,
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
      "url": "${typeof window !== 'undefined' ? window.location.origin : 'https://vaubaan.com'}/mcp",
      "headers": {
        "Authorization": "Bearer ${apiKey}"
      }
    }
  }
}`}
          </pre>
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
          <legend style={{ opacity: 0.7 }}>Capabilities</legend>
          {CAPABILITY_PRESETS.map((cap) => (
            <label key={cap.value} style={{ display: 'block', padding: '6px 0' }}>
              <input
                type="checkbox"
                checked={selected.has(cap.value)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(cap.value);
                  else next.delete(cap.value);
                  setSelected(next);
                }}
              />{' '}
              <strong>{cap.label}</strong> <code style={{ opacity: 0.55 }}>{cap.value}</code>
            </label>
          ))}
          {extra.length > 0 && (
            <div style={{ marginTop: 8, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}>
              {extra.map((value) => (
                <label key={value} style={{ display: 'block', padding: '6px 0' }}>
                  <input type="checkbox" checked readOnly /> <code>{value}</code>{' '}
                  <button
                    type="button"
                    onClick={() => removeExtra(value)}
                    style={{
                      background: 'transparent',
                      color: '#ff7e7e',
                      border: 0,
                      cursor: 'pointer',
                    }}
                  >
                    remove
                  </button>
                </label>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              value={customInput}
              onChange={(e) => {
                setCustomInput(e.target.value);
                setCustomError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustom();
                }
              }}
              placeholder="custom capability, e.g. github:repo/code:write@feature/x"
              style={{
                flex: 1,
                padding: 8,
                background: '#1a1a1a',
                color: '#fff',
                border: '1px solid #2a2a2a',
                borderRadius: 6,
              }}
            />
            <button
              type="button"
              onClick={addCustom}
              style={{
                padding: '8px 12px',
                background: 'transparent',
                color: '#fff',
                border: '1px solid #2a2a2a',
                borderRadius: 6,
              }}
            >
              Add
            </button>
          </div>
          {customError && (
            <p style={{ color: '#ff7e7e', fontSize: 13, margin: '6px 0 0' }}>{customError}</p>
          )}
        </fieldset>
        <button
          type="submit"
          disabled={busy || capabilities.length === 0}
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
