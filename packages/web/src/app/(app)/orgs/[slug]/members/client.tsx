'use client';

import { LocalDate } from '@/components/LocalDate';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface MemberRow {
  user_id: string;
  added_at: string;
  email: string;
}

export function MembersClient({
  orgSlug,
  members,
  currentUserId,
  ownerId,
}: {
  orgSlug: string;
  members: MemberRow[];
  currentUserId: string;
  ownerId: string;
}) {
  const [inviteEmail, setInviteEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<string>('');
  const router = useRouter();
  const isOwner = currentUserId === ownerId;
  const transferCandidates = members.filter((m) => m.user_id !== ownerId);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy('invite');
    setError(null);
    try {
      const res = await fetch('/api/v1/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, email: inviteEmail }),
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

  async function transferOwnership() {
    if (!transferTarget) return;
    const target = members.find((m) => m.user_id === transferTarget);
    if (!target) return;
    if (
      !confirm(
        `Transfer ownership to ${target.email}? You will become a regular member and lose owner protections.`,
      )
    )
      return;
    setBusy('transfer');
    setError(null);
    try {
      const res = await fetch(`/api/v1/orgs/${encodeURIComponent(orgSlug)}/transfer-ownership`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newOwnerId: transferTarget }),
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
        <button type="submit" disabled={busy !== null} style={btn}>
          {busy === 'invite' ? 'Inviting…' : 'Invite member'}
        </button>
      </form>
      {error && <p style={{ color: '#ff7e7e', marginTop: 12 }}>{error}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 24, fontSize: 14 }}>
        <thead>
          <tr>
            <th style={th}>Email</th>
            <th style={th}></th>
            <th style={th}>Added</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const isMemberOwner = m.user_id === ownerId;
            return (
              <tr key={m.user_id} style={{ borderBottom: '1px solid #2a2a2a' }}>
                <td style={td}>
                  {m.email}
                  {m.user_id === currentUserId && <span style={{ opacity: 0.55 }}> (you)</span>}
                </td>
                <td style={td}>
                  {isMemberOwner && (
                    <span
                      style={{
                        padding: '2px 8px',
                        background: '#1a1408',
                        color: '#ffae5e',
                        border: '1px solid #4a3a1c',
                        borderRadius: 4,
                        fontSize: 12,
                      }}
                    >
                      owner
                    </span>
                  )}
                </td>
                <td style={{ ...td, opacity: 0.6 }}>
                  <LocalDate ts={m.added_at} dateOnly />
                </td>
                <td style={td}>
                  {!isMemberOwner && (
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
            );
          })}
        </tbody>
      </table>

      {isOwner && transferCandidates.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 16 }}>Transfer ownership</h2>
          <p style={{ opacity: 0.6, fontSize: 13 }}>
            Owner cannot be removed from the org. To leave, first transfer ownership to another
            member.
          </p>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={transferTarget}
              onChange={(e) => setTransferTarget(e.target.value)}
              style={field}
            >
              <option value="">Pick a new owner…</option>
              {transferCandidates.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.email}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={transferOwnership}
              disabled={!transferTarget || busy !== null}
              style={btn}
            >
              {busy === 'transfer' ? 'Transferring…' : 'Transfer ownership'}
            </button>
          </div>
        </section>
      )}
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
