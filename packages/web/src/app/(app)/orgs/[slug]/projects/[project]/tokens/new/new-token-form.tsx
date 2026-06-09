'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseCapability } from '@vaubaan/shared/capability';
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
import { RingGrid, type RingGridBindings } from '@/lib/capabilities/ring-grid';

export function NewTokenForm({
  orgSlug,
  projectSlug,
  bindings,
}: {
  orgSlug: string;
  projectSlug: string;
  bindings: RingGridBindings;
}) {
  const [name, setName] = useState('');
  const [caps, setCaps] = useState<string[]>([]);
  const [customInput, setCustomInput] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<
    | { kind: 'minted'; apiKey: string }
    | { kind: 'pending'; approvalId: string; pollUrl: string }
    | null
  >(null);
  const router = useRouter();

  function addCustom() {
    const v = customInput.trim();
    if (!v) return;
    try {
      parseCapability(v);
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : 'invalid capability');
      return;
    }
    if (!caps.includes(v)) setCaps([...caps, v]);
    setCustomInput('');
    setCustomError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, projectSlug, name, capabilities: caps }),
      });
      const json = (await res.json()) as {
        api_key?: string;
        approval_id?: string;
        poll_url?: string;
        error?: string;
      };
      if (res.status === 201 && json.api_key) {
        setResult({ kind: 'minted', apiKey: json.api_key });
      } else if (res.status === 202 && json.approval_id) {
        setResult({
          kind: 'pending',
          approvalId: json.approval_id,
          pollUrl: json.poll_url ?? '',
        });
      } else {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (result?.kind === 'minted') {
    return (
      <main>
        <h1>Access token created — copy this api_key now</h1>
        <Card>
          <CardBody>
            <Banner tone="warning">
              Visible <strong>once</strong>. After dismissing this page, only the prefix is
              retrievable.
            </Banner>
            <pre
              style={{
                marginTop: 'var(--space-3)',
                padding: 'var(--space-3)',
                background: 'var(--surface-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                overflow: 'auto',
                fontSize: 14,
              }}
            >
              {result.apiKey}
            </pre>
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
              <Button
                type="button"
                variant="primary"
                onClick={() => void navigator.clipboard.writeText(result.apiKey)}
              >
                Copy
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => router.push(`/orgs/${orgSlug}/projects/${projectSlug}`)}
              >
                Done — back to project
              </Button>
            </div>
          </CardBody>
        </Card>
      </main>
    );
  }

  if (result?.kind === 'pending') {
    return (
      <main>
        <h1>Approval pending</h1>
        <Card>
          <CardBody>
            <p>
              One or more requested capabilities require human confirmation per the project&apos;s
              policy. A request has been opened :
            </p>
            <Code>{result.approvalId}</Code>
            <p style={{ marginTop: 'var(--space-3)' }}>
              Approve it on the project&apos;s{' '}
              <a href={`/orgs/${orgSlug}/projects/${projectSlug}/approvals`}>Approvals page</a> or
              via Telegram (if configured). Once approved, poll <Code>{result.pollUrl}</Code> to
              retrieve the <Code>api_key</Code> exactly once.
            </p>
            <div style={{ marginTop: 'var(--space-3)' }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => router.push(`/orgs/${orgSlug}/projects/${projectSlug}/approvals`)}
              >
                Go to approvals
              </Button>
            </div>
          </CardBody>
        </Card>
      </main>
    );
  }

  return (
    <main>
      <header style={{ marginBottom: 'var(--space-4)' }}>
        <h1 style={{ margin: 0 }}>New access token</h1>
        <Code>
          /{orgSlug}/{projectSlug}/tokens/new
        </Code>
      </header>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Card>
          <CardHeader>
            <CardTitle>Name</CardTitle>
          </CardHeader>
          <CardBody>
            <Field label="Token name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                pattern="^[a-z0-9](-?[a-z0-9])*$"
                required
                placeholder="ci-deploy"
              />
            </Field>
          </CardBody>
        </Card>

        <RingGrid bindings={bindings} value={caps} onChange={setCaps} />

        <Card>
          <CardHeader>
            <CardTitle>Custom capability (escape hatch)</CardTitle>
          </CardHeader>
          <CardBody>
            <p
              style={{
                margin: 0,
                marginBottom: 'var(--space-3)',
                color: 'var(--text-muted)',
                fontSize: 'var(--text-sm)',
              }}
            >
              For capabilities the grid doesn&apos;t list (a provider plane added at runtime, an
              exotic env name, a reserved <Code>@all</Code> fan-out…), type the notation directly.
              It&apos;s validated against the grammar before being accepted.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Field>
                <Input
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
                  placeholder="e.g. github:repo/code:write@feature/x"
                />
              </Field>
              <Button type="button" variant="secondary" onClick={addCustom}>
                Add
              </Button>
            </div>
            {customError && (
              <p style={{ color: 'var(--accent-danger-fg)', marginTop: 'var(--space-2)' }}>
                {customError}
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Granted capabilities ({caps.length})</CardTitle>
          </CardHeader>
          <CardBody>
            {caps.length === 0 ? (
              <p style={{ color: 'var(--text-subtle)', margin: 0 }}>None yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {caps.map((c) => (
                  <li
                    key={c}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: 'var(--space-2) 0',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <Code>{c}</Code>
                    <button
                      type="button"
                      onClick={() => setCaps(caps.filter((x) => x !== c))}
                      style={{
                        background: 'transparent',
                        border: 0,
                        color: 'var(--accent-danger-fg)',
                        cursor: 'pointer',
                        fontSize: 13,
                      }}
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button type="submit" variant="primary" disabled={busy || caps.length === 0 || !name}>
            {busy ? 'Creating…' : 'Create access token'}
          </Button>
          {error && <p style={{ color: 'var(--accent-danger-fg)' }}>{error}</p>}
        </div>
      </form>
    </main>
  );
}
