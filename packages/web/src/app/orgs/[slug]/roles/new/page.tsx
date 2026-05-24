'use client';

import { use as usePromise, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RuleEditor, defaultEmptyRule, type EditableRule } from '../rule-editor';

export default function NewRolePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = usePromise(params);
  const [provider, setProvider] = useState<'github' | 'vercel' | 'supabase'>('github');
  const [shortName, setShortName] = useState('');
  const [description, setDescription] = useState('');
  const [rules, setRules] = useState<EditableRule[]>([defaultEmptyRule()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        orgSlug: slug,
        provider,
        name: `${provider}:${shortName}`,
        description: description || null,
        permissions: { version: 1, rules: rules.map(toStoredRule) },
      };
      const res = await fetch('/api/v1/roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !json.id) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.push(`/orgs/${slug}/roles/${json.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>New custom role</h1>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
          <label>
            <div style={{ opacity: 0.7, marginBottom: 4 }}>Provider</div>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as typeof provider)}
              style={field}
            >
              <option value="github">github</option>
              <option value="vercel">vercel</option>
              <option value="supabase">supabase</option>
            </select>
          </label>
          <label>
            <div style={{ opacity: 0.7, marginBottom: 4 }}>Name (after `{provider}:`)</div>
            <input
              value={shortName}
              onChange={(e) =>
                setShortName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
              }
              required
              pattern="^[a-z0-9](-?[a-z0-9])*$"
              placeholder="e.g. reviewer"
              style={field}
            />
          </label>
        </div>
        <label>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>Description (markdown OK)</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ ...field, fontFamily: 'inherit' }}
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
            {busy ? 'Creating…' : 'Create role'}
          </button>
        </div>
        {error && <p style={{ color: '#ff7e7e' }}>{error}</p>}
      </form>
    </main>
  );
}

function toStoredRule(r: EditableRule) {
  const out: Record<string, unknown> = { effect: r.effect };
  if (r.tool) out.tool = r.tool;
  if (r.tool_matches && r.tool_matches.length > 0) out.tool_matches = r.tool_matches;
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
