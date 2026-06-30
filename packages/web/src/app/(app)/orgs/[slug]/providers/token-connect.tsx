'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

interface TokenConnectConfig {
  placeholder: string;
  hint: string;
  inputType?: 'password' | 'text';
}

const PROVIDER_CONFIG: Record<string, TokenConnectConfig> = {
  'cloudflare-dns': {
    placeholder: 'Paste your Cloudflare API Token',
    hint: 'Create an API Token at dash.cloudflare.com/profile/api-tokens (Zone:Read + DNS:Edit).',
  },
  'upstash-redis': {
    placeholder: 'email:api_key',
    hint: 'Find your Management API key at console.upstash.com/account/api.',
    inputType: 'text',
  },
  resend: {
    placeholder: 're_…',
    hint: 'Create an API key at resend.com/api-keys.',
  },
};

export function TokenConnectButton({ orgSlug, provider }: { orgSlug: string; provider: string }) {
  const router = useRouter();
  const config = PROVIDER_CONFIG[provider];
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!config || !open) {
    return (
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        Connect
      </Button>
    );
  }

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/token-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org: orgSlug, provider, token: token.trim() }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(json.error ?? `Failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }

  const inputStyle = {
    padding: '4px 8px',
    fontSize: 'var(--text-sm)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    width: '100%',
    fontFamily: 'var(--font-mono)',
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', maxWidth: 400 }}>
      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        {config.hint}
        <input
          type={config.inputType ?? 'password'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={config.placeholder}
          style={inputStyle}
        />
      </label>
      {error && (
        <p style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-sm)', margin: 0 }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <Button
          size="sm"
          variant="primary"
          onClick={handleSubmit}
          disabled={!token.trim() || loading}
        >
          {loading ? 'Connecting…' : 'Connect'}
        </Button>
        <button
          onClick={() => setOpen(false)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-sm)',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function TokenConnectHint({ provider }: { provider: string }) {
  const config = PROVIDER_CONFIG[provider];
  if (!config) return null;
  return <p style={{ color: 'var(--text-muted)', margin: 0 }}>{config.hint}</p>;
}
