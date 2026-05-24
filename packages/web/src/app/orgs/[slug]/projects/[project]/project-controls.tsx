'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ProjectControls({
  projectId,
  initialName,
  orgSlug,
}: {
  projectId: string;
  initialName: string;
  orgSlug: string;
}) {
  const [name, setName] = useState(initialName);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, name }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (
      !confirm(`Delete project '${initialName}'? Bindings, bots, and audit history will cascade.`)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/projects/${projectId}?orgSlug=${encodeURIComponent(orgSlug)}`,
        { method: 'DELETE' },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.push(`/orgs/${orgSlug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <form onSubmit={rename} style={{ display: 'flex', gap: 6 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          style={{
            padding: '4px 8px',
            background: '#0c0c0c',
            color: '#fff',
            border: '1px solid #2a2a2a',
            borderRadius: 4,
            fontSize: 14,
          }}
        />
        <button type="submit" disabled={busy} style={btn}>
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setName(initialName);
          }}
          style={btnSecondary}
        >
          Cancel
        </button>
        {error && <span style={{ color: '#ff7e7e', fontSize: 12 }}>{error}</span>}
      </form>
    );
  }

  return (
    <span style={{ display: 'flex', gap: 8 }}>
      <button type="button" onClick={() => setEditing(true)} style={btnSecondary}>
        Rename
      </button>
      <button type="button" onClick={destroy} disabled={busy} style={btnDanger}>
        Delete project
      </button>
      {error && <span style={{ color: '#ff7e7e', fontSize: 12 }}>{error}</span>}
    </span>
  );
}

const btn: React.CSSProperties = {
  padding: '4px 10px',
  background: '#fff',
  color: '#000',
  border: 0,
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
const btnSecondary: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  color: '#fff',
  border: '1px solid #2a2a2a',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
const btnDanger: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  color: '#ff7e7e',
  border: '1px solid #4a1c1c',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
