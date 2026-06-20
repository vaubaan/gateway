'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Field,
  Input,
  Stack,
} from '@/components/ui';

export function StripeConnectForm({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyPrefix = apiKey.slice(0, 8);
  const isValidPrefix =
    apiKey.startsWith('sk_test_') ||
    apiKey.startsWith('sk_live_') ||
    apiKey.startsWith('rk_test_') ||
    apiKey.startsWith('rk_live_');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError('API key is required.');
      return;
    }
    if (!isValidPrefix) {
      setError('Key must start with sk_test_, sk_live_, rk_test_, or rk_live_.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/stripe/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgSlug, apiKey }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.push(`/orgs/${orgSlug}/providers`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <Stack gap="var(--space-4)">
        <Card>
          <CardHeader>
            <CardTitle>Stripe API key</CardTitle>
          </CardHeader>
          <CardBody>
            <Stack gap="var(--space-4)">
              <Field
                label="API key"
                hint={
                  <>
                    Accepted prefixes: <Code>sk_test_</Code>, <Code>sk_live_</Code>,{' '}
                    <Code>rk_test_</Code>, <Code>rk_live_</Code>.
                  </>
                }
              >
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setError(null);
                  }}
                  placeholder="sk_test_…"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </Field>

              {apiKey && isValidPrefix && (
                <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>
                  Mode detected: <strong>{keyPrefix.includes('test') ? 'test' : 'live'}</strong>
                </p>
              )}

              {error && <p style={{ color: 'var(--accent-danger-fg)', margin: 0 }}>{error}</p>}

              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button type="submit" variant="primary" disabled={busy || !apiKey.trim()}>
                  {busy ? 'Validating…' : 'Connect Stripe'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => router.push(`/orgs/${orgSlug}/providers`)}
                >
                  Cancel
                </Button>
              </div>
            </Stack>
          </CardBody>
        </Card>
      </Stack>
    </form>
  );
}
