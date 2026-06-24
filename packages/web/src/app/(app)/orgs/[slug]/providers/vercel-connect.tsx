'use client';

import { useState } from 'react';
import { Button, Code } from '@/components/ui';

export function VercelConnectButton({ orgSlug }: { orgSlug: string }) {
  const [teamId, setTeamId] = useState('');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        Connect
      </Button>
    );
  }

  const href = teamId.trim()
    ? `/api/integrations/vercel/connect?org=${orgSlug}&vercel_team=${encodeURIComponent(teamId.trim())}`
    : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <input
        type="text"
        value={teamId}
        onChange={(e) => setTeamId(e.target.value)}
        placeholder="team_..."
        autoFocus
        style={{
          padding: '4px 8px',
          fontSize: 'var(--text-sm)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          width: 220,
          fontFamily: 'var(--font-mono)',
        }}
      />
      {href ? (
        <a href={href} style={{ textDecoration: 'none' }}>
          <Button size="sm" variant="primary">
            Connect
          </Button>
        </a>
      ) : (
        <Button size="sm" variant="primary" disabled>
          Connect
        </Button>
      )}
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
  );
}

export function VercelTeamIdHint() {
  return (
    <p style={{ color: 'var(--text-muted)', margin: 0 }}>
      Paste your Vercel Team ID (<Code>team_...</Code>) to connect. Find it in{' '}
      <a
        href="https://vercel.com/account"
        target="_blank"
        rel="noreferrer noopener"
        style={{ color: 'var(--accent-fg)' }}
      >
        Vercel → Settings → General
      </a>
      .
    </p>
  );
}
