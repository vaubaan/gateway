'use client';

/**
 * Rotate and revoke (spec §7.8). Rotation reveals the new token once, in the
 * same dialog as issuance; revocation asks for the mission's name. Only an
 * active mission rotates; every mission that is not revoked yet can be
 * revoked, an orphaned or expired one included (spec §2.3: the creator closes
 * an orphaned mission).
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, DangerConfirm } from '@/components/ui';
import type { BootstrapKit } from '@/server/missions/bootstrap-kit';

import { RevealDialog } from '../bootstrap-kit-view';
import styles from '../missions.module.css';

function isRotated(body: unknown): body is { kit: BootstrapKit } {
  return typeof body === 'object' && body !== null && 'kit' in body;
}

function messageOf(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const { message } = body;
    if (typeof message === 'string') return message;
  }
  return `The instance answered ${status}.`;
}

export function MissionActions({
  missionId,
  name,
  active,
  revocable,
}: {
  missionId: string;
  name: string;
  /** The mission serves calls: its token can be rotated. */
  active: boolean;
  /** The mission is not revoked yet. */
  revocable: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kit, setKit] = useState<BootstrapKit | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function post(action: 'rotate' | 'revoke'): Promise<unknown> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}/${action}`, { method: 'POST' });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(messageOf(body, res.status));
        return null;
      }
      return body;
    } catch {
      setError('The instance could not be reached.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    const body = await post('rotate');
    if (isRotated(body)) setKit(body.kit);
  }

  async function revoke() {
    const body = await post('revoke');
    if (body !== null) {
      setConfirming(false);
      router.refresh();
    }
  }

  return (
    <>
      <div className={styles.actions}>
        <a href={`/missions/new?from=${missionId}`} className={styles.secondaryLink}>
          Duplicate
        </a>
        {active && (
          <Button type="button" onClick={rotate} disabled={busy}>
            Rotate token
          </Button>
        )}
        {revocable && (
          <Button
            type="button"
            variant="danger"
            onClick={() => setConfirming(true)}
            disabled={busy}
          >
            Revoke mission
          </Button>
        )}
      </div>
      {error && !confirming && <p className={styles.refused}>{error}</p>}
      {confirming && (
        <DangerConfirm
          title="Revoke this mission"
          body="Every agent using its token is refused from now on (mission-inactive). This cannot be undone; issue or duplicate a mission to continue the work."
          phrase={name}
          confirmLabel="Revoke"
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={revoke}
        />
      )}
      {kit && (
        <RevealDialog
          title={`New token for “${name}”`}
          kit={kit}
          onDone={() => {
            setKit(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
