'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Provider } from '@vaubaan/shared';
import { Button, Input, Select } from '@/components/ui';

interface Binding {
  id: string;
  provider: Provider;
  resource_ref: string;
  display_name: string | null;
  environment: string | null;
}

const ENV_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;

export function BindingControls({
  binding,
  orgSlug,
  resources,
}: {
  binding: Binding;
  orgSlug: string;
  resources: Array<{ ref: string; name: string }>;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [ref, setRef] = useState(binding.resource_ref);
  const [envSlug, setEnvSlug] = useState<string>(binding.environment ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const envClean = envSlug.trim();
    const refChanged = ref !== binding.resource_ref;
    const envChanged = (envClean || null) !== binding.environment;
    if (!refChanged && !envChanged) {
      setEditing(false);
      return;
    }
    if (envClean && !ENV_REGEX.test(envClean)) {
      setError(`Env slug '${envClean}' must be lowercase kebab-case (e.g. 'prod', 'staging').`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const display = resources.find((r) => r.ref === ref)?.name ?? ref;
      const body: Record<string, string | null> = { orgSlug };
      if (refChanged) {
        body.resource_ref = ref;
        body.display_name = display;
      }
      if (envChanged) body.environment = envClean || null;
      const res = await fetch(`/api/v1/bindings/${binding.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
      !window.confirm(
        `Delete the ${binding.provider} binding to ${binding.display_name ?? binding.resource_ref}? Access tokens in this project will no longer reach this resource.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/bindings/${binding.id}?orgSlug=${encodeURIComponent(orgSlug)}`,
        { method: 'DELETE' },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (editing) {
    const knownRef = resources.some((r) => r.ref === ref);
    return (
      <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        {resources.length > 0 ? (
          <Select value={ref} onChange={(e) => setRef(e.target.value)} disabled={busy}>
            {!knownRef && <option value={ref}>{ref} (current)</option>}
            {resources.map((r) => (
              <option key={r.ref} value={r.ref}>
                {r.name}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        <Input
          value={envSlug}
          onChange={(e) => setEnvSlug(e.target.value)}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          placeholder="env (e.g. prod)"
          pattern="^[a-z0-9](-?[a-z0-9])*$"
          style={{ width: 140 }}
        />
        <Button type="button" size="sm" variant="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing(false);
            setRef(binding.resource_ref);
            setEnvSlug(binding.environment ?? '');
            setError(null);
          }}
          disabled={busy}
        >
          Cancel
        </Button>
        {error && (
          <span style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-xs)' }}>
            {error}
          </span>
        )}
      </span>
    );
  }

  return (
    <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <Button type="button" size="sm" variant="danger" onClick={destroy} disabled={busy}>
        {busy ? 'Deleting…' : 'Delete'}
      </Button>
      {error && (
        <span style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-xs)' }}>
          {error}
        </span>
      )}
    </span>
  );
}
