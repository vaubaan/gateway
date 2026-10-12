'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

interface TeamOption {
  id: string;
  name: string;
  slug: string;
}

export function VercelConnectButton({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamOption[] | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState('');

  if (!open) {
    return (
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        Connect
      </Button>
    );
  }

  const canSubmit = token.trim().length > 0 && !loading && (!teams || selectedTeamId.length > 0);

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    try {
      const payload: Record<string, string> = { org: orgSlug, token: token.trim() };
      if (selectedTeamId) payload.teamId = selectedTeamId;

      const res = await fetch('/api/integrations/vercel/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        pickTeam?: TeamOption[];
      };

      if (json.pickTeam) {
        setTeams(json.pickTeam);
        setSelectedTeamId(json.pickTeam[0]?.id ?? '');
        return;
      }

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
        Personal Access Token
        <input
          type="password"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setTeams(null);
            setSelectedTeamId('');
          }}
          placeholder="Paste your Vercel PAT"
          style={inputStyle}
        />
      </label>
      {teams && (
        <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          Team
          <select
            value={selectedTeamId}
            onChange={(e) => setSelectedTeamId(e.target.value)}
            style={{ ...inputStyle, fontFamily: 'inherit' }}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.slug})
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-sm)', margin: 0 }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <Button size="sm" variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
          {loading ? 'Connecting…' : teams ? 'Connect to team' : 'Connect'}
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
      scoped to your team, then paste it here. The team is detected automatically.
    </p>
  );
}
