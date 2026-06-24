'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Code } from '@/components/ui';

export function VercelConnectButton({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        Connect
      </Button>
    );
  }

  const canSubmit = token.trim().length > 0 && teamId.trim().length > 0 && !loading;

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/vercel/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org: orgSlug, token: token.trim(), teamId: teamId.trim() }),
      });
      const json = (await res.json()) as { error?: string };
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
        Team ID
        <input
          type="text"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          placeholder="team_..."
          style={inputStyle}
        />
      </label>
      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        Personal Access Token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste your Vercel PAT"
          style={inputStyle}
        />
      </label>
      {error && (
        <p style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-sm)', margin: 0 }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <Button size="sm" variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
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

export function VercelTeamIdHint() {
  return (
    <p style={{ color: 'var(--text-muted)', margin: 0 }}>
      Create a{' '}
      <a
        href="https://vercel.com/account/settings/tokens"
        target="_blank"
        rel="noreferrer noopener"
        style={{ color: 'var(--accent-fg)' }}
      >
        Personal Access Token
      </a>{' '}
      scoped to your team, then paste it here with the Team ID (<Code>team_...</Code>, found in team
      Settings → General).
    </p>
  );
}
