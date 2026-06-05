'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Field,
  Input,
  Label,
  Stack,
} from '@/components/ui';

interface Binding {
  id: string;
  host_slug: string;
  host_address: string;
  port: number;
  ssh_user: string;
  created_at: string;
}

interface VpsSshPageProps {
  params: Promise<{ slug: string; project: string }>;
}

export default function VpsSshPage({ params: paramsPromise }: VpsSshPageProps) {
  const [orgSlug, setOrgSlug] = useState('');
  const [projectSlug, setProjectSlug] = useState('');
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Form state
  const [hostSlug, setHostSlug] = useState('');
  const [hostAddress, setHostAddress] = useState('');
  const [port, setPort] = useState('22');
  const [sshUser, setSshUser] = useState('dev');
  const [keyMode, setKeyMode] = useState<'generate' | 'paste'>('generate');
  const [pastePem, setPastePem] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [publicKey, setPublicKey] = useState('');

  // Test state
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void paramsPromise.then(({ slug, project }) => {
      setOrgSlug(slug);
      setProjectSlug(project);
      void fetchBindings(slug, project);
    });
  }, [paramsPromise]);

  async function fetchBindings(org: string, proj: string) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(
        `/api/v1/vps-ssh-bindings?orgSlug=${encodeURIComponent(org)}&projectSlug=${encodeURIComponent(proj)}`,
      );
      const json = (await res.json()) as { bindings?: Binding[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Failed to load bindings');
      setBindings(json.bindings ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError('');
    setPublicKey('');
    try {
      const body: Record<string, unknown> = {
        orgSlug,
        projectSlug,
        host_slug: hostSlug,
        host_address: hostAddress,
        port: parseInt(port, 10),
        ssh_user: sshUser,
      };
      if (keyMode === 'generate') {
        body['generate_key'] = true;
      } else {
        body['ssh_private_key_pem'] = pastePem;
      }
      const res = await fetch('/api/v1/vps-ssh-bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        binding?: Binding;
        public_key?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? 'Failed to create binding');
      if (json.public_key) setPublicKey(json.public_key);
      setHostSlug('');
      setHostAddress('');
      setPort('22');
      setSshUser('dev');
      setPastePem('');
      await fetchBindings(orgSlug, projectSlug);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(bindingId: string) {
    if (!confirm('Remove this SSH binding?')) return;
    const res = await fetch(
      `/api/v1/vps-ssh-bindings/${bindingId}?orgSlug=${encodeURIComponent(orgSlug)}`,
      { method: 'DELETE' },
    );
    if (res.ok) {
      await fetchBindings(orgSlug, projectSlug);
    }
  }

  async function handleTest(bindingId: string) {
    setTestingId(bindingId);
    try {
      const res = await fetch(
        `/api/v1/vps-ssh-bindings/${bindingId}/test?orgSlug=${encodeURIComponent(orgSlug)}`,
        { method: 'POST' },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        stdout?: string;
        stderr?: string;
        error?: string;
      };
      setTestResults((prev) => ({
        ...prev,
        [bindingId]: {
          ok: !!json.ok,
          msg: json.ok ? `OK — ${json.stdout ?? ''}` : (json.error ?? json.stderr ?? 'Failed'),
        },
      }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [bindingId]: { ok: false, msg: e instanceof Error ? e.message : 'Error' },
      }));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <main>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ margin: 0 }}>VPS SSH hosts</h1>
        <p style={{ color: 'var(--text-muted)', margin: 'var(--space-2) 0 0' }}>
          Register VPS hosts so AI coding sessions can run shell commands via{' '}
          <Code>vps_ssh__exec</Code>.
        </p>
      </header>

      <Stack gap="var(--space-4)">
        {error && <Banner tone="danger">{error}</Banner>}

        <Card>
          <CardHeader>
            <CardTitle>Registered hosts</CardTitle>
          </CardHeader>
          <CardBody>
            {loading ? (
              <p style={{ color: 'var(--text-subtle)' }}>Loading…</p>
            ) : bindings.length === 0 ? (
              <p style={{ color: 'var(--text-subtle)', margin: 0 }}>No SSH hosts registered yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {bindings.map((b) => (
                  <li
                    key={b.id}
                    style={{
                      padding: 'var(--space-3) 0',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                      }}
                    >
                      <span>
                        <Badge tone="neutral">{b.host_slug}</Badge>{' '}
                        <Code>
                          {b.ssh_user}@{b.host_address}:{b.port}
                        </Code>
                      </span>
                      <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void handleTest(b.id)}
                          disabled={testingId === b.id}
                        >
                          {testingId === b.id ? 'Testing…' : 'Test connection'}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => void handleDelete(b.id)}>
                          Remove
                        </Button>
                      </span>
                    </div>
                    {testResults[b.id] && (
                      <div style={{ marginTop: 'var(--space-2)' }}>
                        <Banner tone={testResults[b.id]?.ok ? 'success' : 'danger'}>
                          {testResults[b.id]?.msg}
                        </Banner>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add a host</CardTitle>
          </CardHeader>
          <CardBody>
            <form onSubmit={(e) => void handleCreate(e)}>
              <Stack gap="var(--space-3)">
                {createError && <Banner tone="danger">{createError}</Banner>}

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 2fr 80px',
                    gap: 'var(--space-3)',
                  }}
                >
                  <Field>
                    <Label>Host slug</Label>
                    <Input
                      placeholder="vps-rp"
                      value={hostSlug}
                      onChange={(e) => setHostSlug(e.target.value)}
                      required
                    />
                  </Field>
                  <Field>
                    <Label>Host address (IP or hostname)</Label>
                    <Input
                      placeholder="192.168.1.10"
                      value={hostAddress}
                      onChange={(e) => setHostAddress(e.target.value)}
                      required
                    />
                  </Field>
                  <Field>
                    <Label>Port</Label>
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

                <Field>
                  <Label>SSH user</Label>
                  <Input
                    placeholder="dev"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    required
                    style={{ maxWidth: 200 }}
                  />
                </Field>

                <div>
                  <Label>SSH private key</Label>
                  <div
                    style={{ display: 'flex', gap: 'var(--space-2)', margin: 'var(--space-2) 0' }}
                  >
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
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
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

                <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>
                  Your private key is stored encrypted. Never reuse a key across multiple services.
                </p>

                <div>
                  <Button type="submit" variant="primary" disabled={creating}>
                    {creating ? 'Adding…' : 'Add host'}
                  </Button>
                </div>
              </Stack>
            </form>

            {publicKey && (
              <div style={{ marginTop: 'var(--space-4)' }}>
                <Banner tone="success">
                  Key pair generated. Add this public key to <Code>~/.ssh/authorized_keys</Code> on
                  your server:
                </Banner>
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
                <Button size="sm" variant="secondary" onClick={() => setPublicKey('')}>
                  Dismiss
                </Button>
              </div>
            )}
          </CardBody>
        </Card>
      </Stack>
    </main>
  );
}
