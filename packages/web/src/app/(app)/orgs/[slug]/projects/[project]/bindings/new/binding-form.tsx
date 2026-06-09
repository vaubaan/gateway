'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Provider } from '@vaubaan/shared';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Label,
  Select,
  Stack,
} from '@/components/ui';
import { getSupabaseBrowser } from '@/lib/supabase/client';

const REF_HINT: Record<string, string> = {
  github: 'owner/repo (e.g. acme/website)',
  vercel: 'prj_XXXXXXXXXXXX',
  supabase: '20-char project ref',
  railway: 'project id (UUID)',
};

interface OfferedProvider {
  provider: Provider;
  resources: Array<{ ref: string; name: string; description?: string; url?: string }>;
  error: string | null;
}

export function BindingForm({
  orgSlug,
  projectId,
  projectSlug,
  offered,
}: {
  orgSlug: string;
  projectId: string;
  projectSlug: string;
  offered: OfferedProvider[];
}) {
  const router = useRouter();

  const [provider, setProvider] = useState<Provider>(offered[0]?.provider ?? 'ssh');
  const isSsh = provider === 'ssh';

  const current = offered.find((o) => o.provider === provider) ?? null;
  const [ref, setRef] = useState<string>(current?.resources[0]?.ref ?? '');

  // SSH fields
  const [hostSlug, setHostSlug] = useState('');
  const [hostAddress, setHostAddress] = useState('');
  const [port, setPort] = useState('22');
  const [sshUser, setSshUser] = useState('dev');
  const [keyMode, setKeyMode] = useState<'generate' | 'paste'>('generate');
  const [pastePem, setPastePem] = useState('');
  const [publicKey, setPublicKey] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onProviderChange(p: Provider) {
    setProvider(p);
    if (p !== 'ssh') {
      const next = offered.find((o) => o.provider === p);
      setRef(next?.resources[0]?.ref ?? '');
    }
    setError(null);
    setPublicKey('');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSsh) {
      await submitSsh();
    } else {
      await submitStandard();
    }
  }

  async function submitStandard() {
    if (!ref) {
      setError('Pick a resource first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      const display = current?.resources.find((r) => r.ref === ref)?.name ?? ref;
      const { error: err } = await supabase.from('provider_bindings').insert({
        project_id: projectId,
        provider,
        resource_ref: ref,
        display_name: display,
      });
      if (err) throw err;
      router.push(`/orgs/${orgSlug}/projects/${projectSlug}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function submitSsh() {
    setBusy(true);
    setError(null);
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
      const res = await fetch('/api/v1/ssh-bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { binding?: unknown; public_key?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.public_key) {
        setPublicKey(json.public_key);
        setBusy(false);
      } else {
        router.push(`/orgs/${orgSlug}/projects/${projectSlug}`);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Stack gap="var(--space-4)">
      {publicKey && (
        <Banner tone="success">
          <p style={{ margin: '0 0 var(--space-2)' }}>
            Key pair generated! Add this public key to <code>~/.ssh/authorized_keys</code> on your
            server:
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
              router.push(`/orgs/${orgSlug}/projects/${projectSlug}`);
              router.refresh();
            }}
          >
            Done — go to project →
          </Button>
        </Banner>
      )}

      <form onSubmit={(e) => void onSubmit(e)}>
        <Card>
          <CardHeader>
            <CardTitle>
              {isSsh ? 'Add SSH binding' : 'Pick a resource from a connected provider'}
            </CardTitle>
          </CardHeader>
          <CardBody>
            <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
              <Field label="Provider">
                <Select
                  value={provider}
                  onChange={(e) => onProviderChange(e.target.value as Provider)}
                >
                  {offered.map((o) => (
                    <option key={o.provider} value={o.provider}>
                      {capitalize(o.provider)}
                      {o.resources.length === 0 ? ' (no resources)' : ''}
                    </option>
                  ))}
                  <option value="ssh">SSH</option>
                </Select>
              </Field>

              {isSsh ? (
                <SshFields
                  hostSlug={hostSlug}
                  setHostSlug={setHostSlug}
                  hostAddress={hostAddress}
                  setHostAddress={setHostAddress}
                  port={port}
                  setPort={setPort}
                  sshUser={sshUser}
                  setSshUser={setSshUser}
                  keyMode={keyMode}
                  setKeyMode={setKeyMode}
                  pastePem={pastePem}
                  setPastePem={setPastePem}
                />
              ) : (
                <Field
                  label="Resource"
                  hint={
                    current?.error
                      ? `${current.error} — type the resource reference manually below.`
                      : current && current.resources.length === 0
                        ? 'No resources visible to the granted token. Type the resource reference manually below.'
                        : 'Pick from the resources the granted token can see.'
                  }
                >
                  {current && current.resources.length > 0 ? (
                    <Select value={ref} onChange={(e) => setRef(e.target.value)}>
                      {(current?.resources ?? []).map((r) => (
                        <option key={r.ref} value={r.ref}>
                          {r.name}
                          {r.description ? ` · ${r.description}` : ''}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      value={ref}
                      onChange={(e) => setRef(e.target.value)}
                      placeholder={REF_HINT[provider]}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                </Field>
              )}

              {error && <p style={{ color: 'var(--accent-danger-fg)', margin: 0 }}>{error}</p>}

              <div>
                <Button type="submit" disabled={busy || (!isSsh && !ref)} variant="primary">
                  {busy ? 'Saving…' : isSsh ? 'Save SSH binding' : 'Save binding'}
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      </form>
    </Stack>
  );
}

function SshFields({
  hostSlug,
  setHostSlug,
  hostAddress,
  setHostAddress,
  port,
  setPort,
  sshUser,
  setSshUser,
  keyMode,
  setKeyMode,
  pastePem,
  setPastePem,
}: {
  hostSlug: string;
  setHostSlug: (v: string) => void;
  hostAddress: string;
  setHostAddress: (v: string) => void;
  port: string;
  setPort: (v: string) => void;
  sshUser: string;
  setSshUser: (v: string) => void;
  keyMode: 'generate' | 'paste';
  setKeyMode: (v: 'generate' | 'paste') => void;
  pastePem: string;
  setPastePem: (v: string) => void;
}) {
  return (
    <>
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
        <Field label="Host address (IP or hostname)">
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
        <Label>Key source</Label>
        <div style={{ display: 'flex', gap: 'var(--space-2)', margin: 'var(--space-2) 0' }}>
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
            placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...'}
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
    </>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
