'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Banner,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Field,
  Input,
  Row,
} from '@/components/ui';

interface Host {
  id: string;
  host_slug: string;
  host_address: string;
  port: number;
  ssh_user: string;
  created_at: string;
}

interface TestResult {
  ok?: boolean;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  duration_ms?: number;
}

export function HostsCard({
  orgSlug,
  bindingId,
  hosts,
}: {
  orgSlug: string;
  bindingId: string;
  hosts: Host[];
}) {
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hosts</CardTitle>
        {adding ? (
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            + Add host
          </Button>
        )}
      </CardHeader>
      <CardBody>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
          Each host attached here is one env in{' '}
          <Code>bash:&lt;ring&gt;:&lt;action&gt;@&lt;host_slug&gt;</Code>. The same script runs on
          all of them ; pick the target host when invoking a tool.
        </p>

        {adding && (
          <AddHostForm orgSlug={orgSlug} bindingId={bindingId} onDone={() => setAdding(false)} />
        )}

        {hosts.length === 0 ? (
          !adding && (
            <p style={{ color: 'var(--text-subtle)', margin: 0 }}>
              No host attached. Click <strong>+ Add host</strong> to wire one.
            </p>
          )
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {hosts.map((h) => (
              <li
                key={h.id}
                style={{
                  padding: 'var(--space-3) 0',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <HostRow orgSlug={orgSlug} bindingId={bindingId} host={h} />
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function HostRow({ orgSlug, bindingId, host }: { orgSlug: string; bindingId: string; host: Host }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function test() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(
        `/api/v1/bash-bindings/${bindingId}/hosts/${host.id}/test?orgSlug=${encodeURIComponent(orgSlug)}`,
        { method: 'POST' },
      );
      const json = (await res.json()) as TestResult;
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (!window.confirm(`Detach host '${host.host_slug}' from this binding?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/bash-bindings/${bindingId}/hosts/${host.id}?orgSlug=${encodeURIComponent(orgSlug)}`,
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

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 'var(--space-3)',
      }}
    >
      <div style={{ display: 'grid', gap: 4 }}>
        <Row gap="var(--space-2)">
          <Code>@{host.host_slug}</Code>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            {host.ssh_user}@{host.host_address}:{host.port}
          </span>
        </Row>
        {result && (
          <Row gap="var(--space-2)">
            <Badge tone={result.ok ? 'success' : 'danger'}>
              {result.error ? 'error' : `exit ${result.exit_code} · ${result.duration_ms} ms`}
            </Badge>
            {result.error && (
              <span style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-xs)' }}>
                {result.error}
              </span>
            )}
            {result.stdout && (
              <Code style={{ fontSize: 'var(--text-xs)' }}>{result.stdout.trim()}</Code>
            )}
          </Row>
        )}
        {error && (
          <span style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-xs)' }}>
            {error}
          </span>
        )}
      </div>
      <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button size="sm" variant="ghost" onClick={() => void test()} disabled={busy}>
          {busy ? '…' : 'Test'}
        </Button>
        <Button size="sm" variant="danger" onClick={() => void destroy()} disabled={busy}>
          Detach
        </Button>
      </span>
    </div>
  );
}

function AddHostForm({
  orgSlug,
  bindingId,
  onDone,
}: {
  orgSlug: string;
  bindingId: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [hostSlug, setHostSlug] = useState('');
  const [hostAddress, setHostAddress] = useState('');
  const [port, setPort] = useState('22');
  const [sshUser, setSshUser] = useState('dev');
  const [keyMode, setKeyMode] = useState<'generate' | 'paste'>('generate');
  const [pastePem, setPastePem] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setPublicKey(null);
    try {
      const body: Record<string, unknown> = {
        orgSlug,
        host_slug: hostSlug,
        host_address: hostAddress,
        port: parseInt(port, 10),
        ssh_user: sshUser,
      };
      if (keyMode === 'generate') body['generate_key'] = true;
      else body['ssh_private_key_pem'] = pastePem;
      const res = await fetch(`/api/v1/bash-bindings/${bindingId}/hosts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { host?: unknown; public_key?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.public_key) {
        setPublicKey(json.public_key);
      } else {
        onDone();
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (publicKey) {
    return (
      <Banner tone="success">
        <p style={{ margin: '0 0 var(--space-2)' }}>
          Key pair generated. Add this public key to <code>~/.ssh/authorized_keys</code> on the host
          :
        </p>
        <pre
          style={{
            background: 'var(--surface-raised)',
            padding: 'var(--space-3)',
            borderRadius: 4,
            overflowX: 'auto',
            fontSize: '0.8em',
            margin: 'var(--space-2) 0',
          }}
        >
          {`mkdir -p ~/.ssh && chmod 700 ~/.ssh\necho '${publicKey}' >> ~/.ssh/authorized_keys\nchmod 600 ~/.ssh/authorized_keys`}
        </pre>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onDone();
            router.refresh();
          }}
        >
          Done →
        </Button>
      </Banner>
    );
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      style={{
        display: 'grid',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 'var(--space-3)',
      }}
    >
      {error && <Banner tone="danger">{error}</Banner>}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 2fr 80px',
          gap: 'var(--space-3)',
        }}
      >
        <Field label="Host slug">
          <Input
            placeholder="vps-rp"
            value={hostSlug}
            onChange={(e) => setHostSlug(e.target.value)}
            required
          />
        </Field>
        <Field label="Address (IP or hostname)">
          <Input
            placeholder="192.168.1.10"
            value={hostAddress}
            onChange={(e) => setHostAddress(e.target.value)}
            required
          />
        </Field>
        <Field label="Port">
          <Input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            min={1}
            max={65535}
            required
          />
        </Field>
      </div>

      <Field label="SSH user">
        <Input
          placeholder="dev"
          value={sshUser}
          onChange={(e) => setSshUser(e.target.value)}
          required
          style={{ maxWidth: 200 }}
        />
      </Field>

      <div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <Button
            type="button"
            size="sm"
            variant={keyMode === 'generate' ? 'primary' : 'secondary'}
            onClick={() => setKeyMode('generate')}
          >
            Generate key pair
          </Button>
          <Button
            type="button"
            size="sm"
            variant={keyMode === 'paste' ? 'primary' : 'secondary'}
            onClick={() => setKeyMode('paste')}
          >
            Paste private key
          </Button>
        </div>
        {keyMode === 'paste' && (
          <textarea
            rows={6}
            placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
            value={pastePem}
            onChange={(e) => setPastePem(e.target.value)}
            required
            style={{
              width: '100%',
              fontFamily: 'monospace',
              fontSize: '0.8em',
              padding: 'var(--space-2)',
              boxSizing: 'border-box',
            }}
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add host'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
