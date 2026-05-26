'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface MemberRow {
  user_id: string;
  role: 'member' | 'admin';
  added_at: string;
  email: string;
}

export function MembersClient({
  orgSlug,
  members,
  currentUserId,
  isAdmin,
}: {
  orgSlug: string;
  members: MemberRow[];
  currentUserId: string;
  isAdmin: boolean;
}) {
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy('invite');
    setError(null);
    try {
      const res = await fetch('/api/v1/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, email: inviteEmail, role: inviteRole }),
      });
      const json = (await res.json()) as { error?: string; invited?: boolean };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setInviteEmail('');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function changeRole(userId: string, nextRole: 'member' | 'admin') {
    setBusy(userId);
    setError(null);
    try {
      const res = await fetch(`/api/v1/members/${userId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, role: nextRole }),
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

  async function removeMember(userId: string, email: string) {
    if (!confirm(`Remove ${email} from this org?`)) return;
    setBusy(userId);
    setError(null);
    try {
      const res = await fetch(`/api/v1/members/${userId}?orgSlug=${encodeURIComponent(orgSlug)}`, {
        method: 'DELETE',
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

  return (
    <>
      {isAdmin && (
        <form
          onSubmit={invite}
          style={{ marginTop: 24, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <input
            type="email"
            required
            placeholder="user@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            style={field}
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as 'member' | 'admin')}
            style={field}
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button type="submit" disabled={busy !== null} style={btn}>
            {busy === 'invite' ? 'Inviting…' : 'Invite'}
          </button>
        </form>
      )}
      {error && <p style={{ color: '#ff7e7e', marginTop: 12 }}>{error}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 24, fontSize: 14 }}>
        <thead>
          <tr>
            <th style={th}>Email</th>
            <th style={th}>Role</th>
            <th style={th}>Added</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user_id} style={{ borderBottom: '1px solid #2a2a2a' }}>
              <td style={td}>
                {m.email}
                {m.user_id === currentUserId && <span style={{ opacity: 0.55 }}> (you)</span>}
              </td>
              <td style={td}>
                {isAdmin ? (
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m.user_id, e.target.value as 'member' | 'admin')}
                    disabled={busy === m.user_id}
                    style={inlineField}
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                ) : (
                  m.role
                )}
              </td>
              <td style={{ ...td, opacity: 0.6 }}>{new Date(m.added_at).toLocaleDateString()}</td>
              <td style={td}>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => removeMember(m.user_id, m.email)}
                    disabled={busy === m.user_id}
                    style={btnDanger}
                  >
                    {busy === m.user_id ? '…' : 'Remove'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const field: React.CSSProperties = {
  padding: '8px 10px',
  background: '#0c0c0c',
  color: '#fff',
  border: '1px solid #2a2a2a',
  borderRadius: 6,
  fontSize: 14,
};
const inlineField: React.CSSProperties = {
  padding: '4px 8px',
  background: '#0c0c0c',
  color: '#fff',
  border: '1px solid #2a2a2a',
  borderRadius: 4,
  fontSize: 13,
};
const btn: React.CSSProperties = {
  padding: '8px 14px',
  background: '#fff',
  color: '#000',
  border: 0,
  borderRadius: 6,
};
const btnDanger: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  color: '#ff7e7e',
  border: '1px solid #4a1c1c',
  borderRadius: 4,
  fontSize: 12,
};
const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid #2a2a2a',
  opacity: 0.7,
  fontWeight: 500,
};
const td: React.CSSProperties = { padding: '8px 12px' };
