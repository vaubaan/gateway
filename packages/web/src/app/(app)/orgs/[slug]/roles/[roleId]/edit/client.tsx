'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RuleEditor, ruleFromStored, defaultEmptyRule, type EditableRule } from '../../rule-editor';

interface RoleRow {
  id: string;
  organization_id: string | null;
  provider: 'github' | 'vercel' | 'supabase' | 'railway';
  name: string;
  description: string | null;
  is_builtin: boolean;
  permissions: { version: 1; rules: Record<string, unknown>[] };
}

export function RoleEditClient({ orgSlug, role }: { orgSlug: string; role: RoleRow }) {
  const [description, setDescription] = useState(role.description ?? '');
  const [rules, setRules] = useState<EditableRule[]>(
    role.permissions.rules.map((r) => ruleFromStored(r)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/roles/${role.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgSlug,
          description: description || null,
          permissions: { version: 1, rules: rules.map(toStoredRule) },
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.push(`/orgs/${orgSlug}/roles/${role.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function destroy() {
    if (!confirm(`Delete custom role '${role.name}'?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/roles/${role.id}?orgSlug=${encodeURIComponent(orgSlug)}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.push(`/orgs/${orgSlug}/roles`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Edit role — {role.name}</h1>
      <code style={{ opacity: 0.55 }}>provider {role.provider} · custom</code>

      <form onSubmit={save} style={{ display: 'grid', gap: 16, maxWidth: 720, marginTop: 24 }}>
        <label>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>Description</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={field}
          />
        </label>

        <section>
          <h2 style={{ fontSize: 16, margin: '12px 0' }}>Rules</h2>
          {rules.map((rule, i) => (
            <RuleEditor
              key={i}
              rule={rule}
              onChange={(next) => setRules((rs) => rs.map((r, j) => (j === i ? next : r)))}
              onDelete={
                rules.length > 1 ? () => setRules((rs) => rs.filter((_, j) => j !== i)) : undefined
              }
              onMove={(direction) => {
                setRules((rs) => {
                  const next = [...rs];
                  const newIdx = direction === 'up' ? i - 1 : i + 1;
                  if (newIdx < 0 || newIdx >= rs.length) return rs;
                  [next[i], next[newIdx]] = [next[newIdx]!, next[i]!];
                  return next;
                });
              }}
            />
          ))}
          <button
            type="button"
            onClick={() => setRules((rs) => [...rs, defaultEmptyRule()])}
            style={{ ...field, width: 'auto', cursor: 'pointer' }}
          >
            + Add rule
          </button>
        </section>

        <div style={{ display: 'flex', gap: 8 }}>
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
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={destroy}
            disabled={busy}
            style={{
              padding: '10px 14px',
              background: 'transparent',
              color: '#ff7e7e',
              border: '1px solid #4a1c1c',
              borderRadius: 6,
            }}
          >
            Delete role
          </button>
        </div>
        {error && <p style={{ color: '#ff7e7e' }}>{error}</p>}
      </form>
    </main>
  );
}

function toStoredRule(r: EditableRule) {
  const out: Record<string, unknown> = { effect: r.effect };
  if (r.toolKind === 'exact' && r.tool) out.tool = r.tool;
  if (r.toolKind === 'glob' && r.tool_matches && r.tool_matches.length > 0)
    out.tool_matches = r.tool_matches;
  if (r.target && r.target !== '*') out.target = r.target;
  if (r.constraints && r.constraints.length > 0) {
    const c: Record<string, unknown> = {};
    for (const k of r.constraints) {
      const op = k.operator;
      if (op === 'equals') c[k.path] = { equals: k.value };
      else if (op === 'in') c[k.path] = { in: k.value.split(',').map((v) => v.trim()) };
      else if (op === 'not_in') c[k.path] = { not_in: k.value.split(',').map((v) => v.trim()) };
      else if (op === 'match') c[k.path] = { match: k.value.split(',').map((v) => v.trim()) };
      else if (op === 'regex') c[k.path] = { regex: k.value };
      else if (op === 'starts_with')
        c[k.path] = { starts_with: k.value.split(',').map((v) => v.trim()) };
      else if (op === 'not_starts_with')
        c[k.path] = { not_starts_with: k.value.split(',').map((v) => v.trim()) };
    }
    out.constraints = c;
  }
  if (r.priority !== undefined && r.priority !== null) out.priority = r.priority;
  return out;
}

const field: React.CSSProperties = {
  padding: 10,
  borderRadius: 6,
  background: '#1a1a1a',
  color: '#fff',
  border: '1px solid #2a2a2a',
  width: '100%',
};
