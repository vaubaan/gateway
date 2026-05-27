'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Field,
  Input,
} from '@/components/ui';

interface RoleRow {
  id: string;
  name: string;
  provider: 'github' | 'vercel' | 'supabase';
  description: string | null;
}

export function TokenControls({
  tokenId,
  tokenName,
  tokenStatus,
  orgSlug,
  projectSlug,
  roles,
  attachedRoleIds,
}: {
  tokenId: string;
  tokenName: string;
  tokenStatus: 'active' | 'revoked';
  orgSlug: string;
  projectSlug: string;
  roles: RoleRow[];
  attachedRoleIds: string[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(attachedRoleIds));
  const [name, setName] = useState(tokenName);
  const router = useRouter();

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (name === tokenName) return;
    setBusy('name');
    setError(null);
    try {
      const res = await fetch(`/api/v1/tokens/${tokenId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, name }),
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

  async function rotate() {
    if (!window.confirm('Rotate the api_key? The current one will stop working immediately.'))
      return;
    setBusy('rotate');
    setError(null);
    try {
      const res = await fetch(`/api/v1/tokens/${tokenId}/rotate-key`, {
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
    const next = tokenStatus === 'active' ? 'revoked' : 'active';
    if (!window.confirm(`Set this access token's status to ${next}?`)) return;
    setBusy('status');
    setError(null);
    try {
      const res = await fetch(`/api/v1/tokens/${tokenId}`, {
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
      const res = await fetch(`/api/v1/tokens/${tokenId}`, {
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
    if (!window.confirm(`Delete access token '${tokenName}' permanently? This cannot be undone.`))
      return;
    setBusy('delete');
    setError(null);
    try {
      const res = await fetch(`/api/v1/tokens/${tokenId}?orgSlug=${encodeURIComponent(orgSlug)}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.refresh();
      router.push(`/orgs/${orgSlug}/projects/${projectSlug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  if (newApiKey) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>New api_key — copy now</CardTitle>
        </CardHeader>
        <CardBody>
          <Banner tone="warning">
            Visible <strong>once</strong>. Copy this value into your <Code>mcp.json</Code> now.
          </Banner>
          <pre
            style={{
              padding: 'var(--space-3)',
              background: 'var(--surface-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              fontFamily: 'var(--font-geist-mono)',
              fontSize: 'var(--text-sm)',
              overflow: 'auto',
              marginTop: 'var(--space-3)',
            }}
          >
            {newApiKey}
          </pre>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            <Button
              type="button"
              variant="primary"
              onClick={() => void navigator.clipboard.writeText(newApiKey)}
            >
              Copy
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setNewApiKey(null);
                router.refresh();
              }}
            >
              Done
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Card>
        <CardHeader>
          <CardTitle>Rename</CardTitle>
        </CardHeader>
        <CardBody>
          <form onSubmit={saveName} style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Field>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                pattern="^[a-z0-9](-?[a-z0-9])*$"
                required
                disabled={busy !== null}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={busy !== null || name === tokenName}>
              {busy === 'name' ? 'Saving…' : 'Save name'}
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardBody>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button type="button" variant="primary" onClick={rotate} disabled={busy !== null}>
              {busy === 'rotate' ? 'Rotating…' : 'Rotate api_key'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={toggleStatus}
              disabled={busy !== null}
            >
              {busy === 'status'
                ? '…'
                : tokenStatus === 'active'
                  ? 'Revoke (block all calls)'
                  : 'Reactivate'}
            </Button>
            <Button type="button" variant="danger" onClick={destroy} disabled={busy !== null}>
              {busy === 'delete' ? 'Deleting…' : 'Delete token'}
            </Button>
          </div>
          {error && (
            <p style={{ color: 'var(--accent-danger-fg)', marginTop: 'var(--space-3)' }}>{error}</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={saveRoles}
            disabled={busy !== null}
          >
            {busy === 'roles' ? 'Saving…' : 'Save roles'}
          </Button>
        </CardHeader>
        <CardBody>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            {roles.map((r) => (
              <label
                key={r.id}
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  alignItems: 'baseline',
                  padding: 'var(--space-2) 0',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(r.id);
                    else next.delete(r.id);
                    setSelected(next);
                  }}
                />
                <span>
                  <strong>{r.name}</strong>
                  {r.description && (
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                      {r.description}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
        </CardBody>
      </Card>
    </div>
  );
}
