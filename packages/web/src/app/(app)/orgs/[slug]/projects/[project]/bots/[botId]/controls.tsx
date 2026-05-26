'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface RoleRow {
  id: string;
  name: string;
  provider: 'github' | 'vercel' | 'supabase';
  description: string | null;
}

export function BotControls({
  botId,
  botName,
  botStatus,
  orgSlug,
  projectSlug,
  roles,
  attachedRoleIds,
}: {
  botId: string;
  botName: string;
  botStatus: 'active' | 'revoked';
  orgSlug: string;
  projectSlug: string;
  roles: RoleRow[];
  attachedRoleIds: string[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(attachedRoleIds));
  const router = useRouter();

  async function rotate() {
    if (!confirm('Rotate the api_key? The current one will stop working immediately.')) return;
    setBusy('rotate');
    setError(null);
    try {
      const res = await fetch(`/api/v1/bots/${botId}/rotate-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug }),
      });
      const json = (await res.json()) as { api_key?: string; error?: string };
      if (!res.ok || !json.api_key) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNewApiKey(json.api_key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function toggleStatus() {
    const next = botStatus === 'active' ? 'revoked' : 'active';
    if (!confirm(`Set this bot's status to ${next}?`)) return;
    setBusy('status');
    setError(null);
    try {
      const res = await fetch(`/api/v1/bots/${botId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, status: next }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveRoles() {
    setBusy('roles');
    setError(null);
    try {
      const res = await fetch(`/api/v1/bots/${botId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, roleIds: Array.from(selected) }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function destroy() {
    if (!confirm(`Delete bot '${botName}' permanently? This cannot be undone.`)) return;
    setBusy('delete');
    setError(null);
    try {
      const res = await fetch(`/api/v1/bots/${botId}?orgSlug=${encodeURIComponent(orgSlug)}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.push(`/orgs/${orgSlug}/projects/${projectSlug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  if (newApiKey) {
    return (
      <section style={{ marginTop: 24 }}>
        <div
          style={{
            padding: 24,
            border: '2px solid #ffae5e',
            borderRadius: 8,
            background: '#1a1408',
          }}
        >
          <p style={{ color: '#ffae5e', marginTop: 0 }}>
            ⚠️ New api_key — visible <strong>once</strong>. Copy it now, paste it in your{' '}
            <code>mcp.json</code>.
          </p>
          <pre style={preStyle}>{newApiKey}</pre>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(newApiKey);
            }}
            style={primaryBtn}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => {
              setNewApiKey(null);
              router.refresh();
            }}
            style={{ ...secondaryBtn, marginLeft: 8 }}
          >
            Done
          </button>
        </div>
      </section>
    );
  }

  return (
    <>
      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16 }}>Actions</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={rotate} disabled={busy !== null} style={primaryBtn}>
            {busy === 'rotate' ? 'Rotating…' : 'Rotate api_key'}
          </button>
          <button
            type="button"
            onClick={toggleStatus}
            disabled={busy !== null}
            style={secondaryBtn}
          >
            {busy === 'status'
              ? '…'
              : botStatus === 'active'
                ? 'Revoke (block all calls)'
                : 'Reactivate'}
          </button>
          <button type="button" onClick={destroy} disabled={busy !== null} style={dangerBtn}>
            {busy === 'delete' ? 'Deleting…' : 'Delete bot'}
          </button>
        </div>
        {error && <p style={{ color: '#ff7e7e', marginTop: 12 }}>{error}</p>}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16 }}>Roles</h2>
        <fieldset style={{ border: '1px solid #2a2a2a', borderRadius: 6, padding: 12 }}>
          {roles.map((r) => (
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
          type="button"
          onClick={saveRoles}
          disabled={busy !== null}
          style={{ ...primaryBtn, marginTop: 8 }}
        >
          {busy === 'roles' ? 'Saving…' : 'Save roles'}
        </button>
      </section>
    </>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: '8px 14px',
  background: '#fff',
  color: '#000',
  border: 0,
  borderRadius: 6,
};
const secondaryBtn: React.CSSProperties = {
  padding: '8px 14px',
  background: 'transparent',
  color: '#fff',
  border: '1px solid #2a2a2a',
  borderRadius: 6,
};
const dangerBtn: React.CSSProperties = {
  padding: '8px 14px',
  background: 'transparent',
  color: '#ff7e7e',
  border: '1px solid #4a1c1c',
  borderRadius: 6,
};
const preStyle: React.CSSProperties = {
  padding: 16,
  background: '#000',
  borderRadius: 4,
  overflow: 'auto',
  fontSize: 14,
};
