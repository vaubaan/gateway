'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Field,
  Input,
  Select,
} from '@/components/ui';

export interface PolicyRuleRow {
  id: string;
  provider: string;
  plane: string;
  level: string;
  action: 'read' | 'write' | '*';
  env_pattern: string;
  gate: 'ai' | 'human';
  priority: number;
}

export function PolicyControls({
  rules,
  projectId,
  orgSlug,
}: {
  rules: PolicyRuleRow[];
  projectId: string;
  orgSlug: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState('*');
  const [plane, setPlane] = useState('*');
  const [level, setLevel] = useState('*');
  const [action, setAction] = useState<'read' | 'write' | '*'>('*');
  const [envPattern, setEnvPattern] = useState('*');
  const [gate, setGate] = useState<'ai' | 'human'>('ai');
  const [priority, setPriority] = useState(100);

  async function addRule(e: React.FormEvent) {
    e.preventDefault();
    setBusy('add');
    setError(null);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/policy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgSlug,
          provider,
          plane,
          level,
          action,
          env_pattern: envPattern,
          gate,
          priority,
        }),
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

  async function delRule(id: string) {
    if (!window.confirm('Delete this policy rule?')) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/projects/${projectId}/policy/${id}?orgSlug=${encodeURIComponent(orgSlug)}`,
        { method: 'DELETE' },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Card>
        <CardHeader>
          <CardTitle>Add a rule</CardTitle>
        </CardHeader>
        <CardBody>
          <form
            onSubmit={addRule}
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 'var(--space-2)',
              alignItems: 'end',
            }}
          >
            <Field label="provider">
              <Input value={provider} onChange={(e) => setProvider(e.target.value)} required />
            </Field>
            <Field label="plane">
              <Input value={plane} onChange={(e) => setPlane(e.target.value)} required />
            </Field>
            <Field label="level">
              <Input value={level} onChange={(e) => setLevel(e.target.value)} required />
            </Field>
            <Field label="action">
              <Select
                value={action}
                onChange={(e) => setAction(e.target.value as 'read' | 'write' | '*')}
              >
                <option value="*">*</option>
                <option value="read">read</option>
                <option value="write">write</option>
              </Select>
            </Field>
            <Field label="env pattern">
              <Input
                value={envPattern}
                onChange={(e) => setEnvPattern(e.target.value)}
                required
                placeholder="* / main / feature/x / prod"
              />
            </Field>
            <Field label="gate">
              <Select value={gate} onChange={(e) => setGate(e.target.value as 'ai' | 'human')}>
                <option value="ai">ai</option>
                <option value="human">human</option>
              </Select>
            </Field>
            <Field label="priority">
              <Input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                min={0}
                max={10000}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={busy === 'add'}>
              {busy === 'add' ? 'Adding…' : '+ Add rule'}
            </Button>
          </form>
          {error && (
            <p style={{ color: 'var(--accent-danger-fg)', marginTop: 'var(--space-3)' }}>{error}</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rules ({rules.length})</CardTitle>
        </CardHeader>
        <CardBody>
          {rules.length === 0 ? (
            <p style={{ color: 'var(--text-subtle)', margin: 0 }}>
              No rules yet — every mint is human-gated by default-deny.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {rules.map((r) => (
                <li
                  key={r.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-2) 0',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <Badge tone={r.gate === 'ai' ? 'success' : 'warning'}>{r.gate}</Badge>
                  <Code style={{ flex: 1 }}>
                    {r.provider}:{r.plane}/{r.level}:{r.action}@{r.env_pattern}
                  </Code>
                  <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--text-sm)' }}>
                    p={r.priority}
                  </span>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => delRule(r.id)}
                    disabled={busy === r.id}
                  >
                    {busy === r.id ? '…' : 'Delete'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
