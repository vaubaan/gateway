'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, Hint, Input } from '@/components/ui';
import type { MissionService } from '@/server/missions/mission-service';
import type { MissionPolicyEntry } from '@vaubaan/shared';
import styles from './permissions-editor.module.css';

type Editor = NonNullable<Awaited<ReturnType<MissionService['permissionOptions']>>>;
export function PermissionsEditor({
  data,
  requestId,
  requested = [],
}: {
  data: Editor;
  requestId?: string;
  requested?: readonly string[];
}) {
  const router = useRouter();
  const [policy, setPolicy] = useState<readonly MissionPolicyEntry[]>(data.policy);
  const [filter, setFilter] = useState('');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const original = new Map(data.policy.map((p) => [p.risk_id, p]));
  const selected = new Map(policy.map((p) => [p.risk_id, p]));
  const candidates = [
    ...data.candidates,
    ...data.policy
      .filter((p) => !data.candidates.some((c) => c.risk_id === p.risk_id))
      .map((p) => ({
        risk_id: p.risk_id,
        label: p.risk_id,
        level: '',
        available: false,
        reason: 'No longer offered by the catalog.',
        ceiling: null,
      })),
  ].sort(
    (a, b) =>
      Number(requested.includes(b.risk_id)) - Number(requested.includes(a.risk_id)) ||
      a.label.localeCompare(b.label),
  );
  const additions = policy.filter((p) => !original.has(p.risk_id));
  const removals = data.policy.filter((p) => !selected.has(p.risk_id));
  const invalid = additions.some(
    (p) =>
      !Number.isSafeInteger(p.quota) ||
      p.quota < 1 ||
      !Number.isSafeInteger(p.rate_limit.max) ||
      p.rate_limit.max < 1,
  );
  const incomplete = requested.some((id) => !selected.has(id));
  function toggle(id: string) {
    setPolicy((current) =>
      current.some((p) => p.risk_id === id)
        ? current.filter((p) => p.risk_id !== id)
        : [
            ...current,
            original.get(id) ?? {
              risk_id: id,
              quota: 1,
              rate_limit: { max: 1, window_seconds: 60 },
              gate: 'approval',
            },
          ],
    );
  }
  function change(id: string, patch: Partial<MissionPolicyEntry>) {
    setPolicy((current) => current.map((p) => (p.risk_id === id ? { ...p, ...patch } : p)));
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/missions/${encodeURIComponent(data.missionId)}/permissions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            policy,
            expected_policy: data.policy,
            ...(requestId ? { request_id: requestId } : {}),
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string; issues?: { message: string }[] };
        setError(
          body.error === 'conflict'
            ? 'The mission or request changed. Reload this page and review the current permissions.'
            : body.issues?.map((i) => i.message).join(' ') ||
                'The change was refused. Reload to check your current access.',
        );
        return;
      }
      setReview(false);
      router.push(
        requestId ? `/waiting/${requestId}?decided=1` : `/missions/${data.missionId}#permissions`,
      );
      router.refresh();
    } catch {
      setError('The gateway could not be reached.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div data-testid="permissions-editor" className={styles.editor}>
      <p>
        Add or remove permissions for every person and key on this mission. Existing keys, history
        and used calls stay.
      </p>
      <Input
        aria-label="Find a permission"
        placeholder="Find a permission"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className={styles.scroll}>
        <table className={styles.table}>
          <caption>Permissions of {data.missionName}</caption>
          <thead>
            <tr>
              <th>Include</th>
              <th>Permission</th>
              <th>
                {data.periodSeconds === null
                  ? 'In total'
                  : `Per ${data.periodSeconds / 3600} hours`}
              </th>
              <th>Calls per minute</th>
              <th>Ask first</th>
            </tr>
          </thead>
          <tbody>
            {candidates
              .filter((c) => `${c.label} ${c.risk_id}`.toLowerCase().includes(filter.toLowerCase()))
              .map((c) => {
                const p = selected.get(c.risk_id);
                const existing = original.has(c.risk_id);
                return (
                  <tr key={c.risk_id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Include ${c.risk_id}`}
                        checked={!!p}
                        disabled={!existing && !c.available}
                        onChange={() => toggle(c.risk_id)}
                      />
                    </td>
                    <td>
                      <strong>{c.label}</strong> {c.level && <span>· {c.level}</span>}
                      <br />
                      <code>{c.risk_id}</code>
                      {requested.includes(c.risk_id) && <p>Requested by the agent</p>}
                      {!existing && !c.available && <p>{c.reason}</p>}
                    </td>
                    <td>
                      {p &&
                        (existing ? (
                          p.quota
                        ) : (
                          <Input
                            type="number"
                            min={1}
                            step={1}
                            aria-label={`Quota for ${c.risk_id}`}
                            value={p.quota}
                            onChange={(e) => change(c.risk_id, { quota: Number(e.target.value) })}
                          />
                        ))}
                    </td>
                    <td>
                      {p &&
                        (existing ? (
                          `${p.rate_limit.max} / ${p.rate_limit.window_seconds}s`
                        ) : (
                          <Input
                            type="number"
                            min={1}
                            max={c.ceiling ?? undefined}
                            step={1}
                            aria-label={`Rate for ${c.risk_id}`}
                            value={p.rate_limit.max}
                            onChange={(e) =>
                              change(c.risk_id, {
                                rate_limit: { max: Number(e.target.value), window_seconds: 60 },
                              })
                            }
                          />
                        ))}
                    </td>
                    <td>
                      {p && (
                        <input
                          type="checkbox"
                          aria-label={`Ask first for ${c.risk_id}`}
                          disabled={existing}
                          checked={p.gate === 'approval'}
                          onChange={(e) =>
                            change(c.risk_id, { gate: e.target.checked ? 'approval' : 'auto' })
                          }
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      {requested
        .filter((id) => !candidates.some((c) => c.risk_id === id))
        .map((id) => (
          <p key={id}>The requested permission {id} is not available on this mission.</p>
        ))}
      <Hint>
        Use the mission’s limit and “ask first” controls to change an existing permission. Adding a
        previously removed permission keeps its earlier consumption.
      </Hint>
      <Button
        disabled={
          busy || invalid || incomplete || (!requestId && additions.length + removals.length === 0)
        }
        onClick={() => setReview(true)}
      >
        Review permissions
      </Button>
      <ConfirmDialog
        open={review}
        title="Change this mission’s permissions?"
        consequence={
          <>
            <ul>
              {additions.map((p) => (
                <li key={p.risk_id}>
                  Add {p.risk_id}: {p.quota} per period, {p.rate_limit.max} per minute,{' '}
                  {p.gate === 'approval' ? 'ask me first' : 'runs freely'}.
                </li>
              ))}
              {removals.map((p) => (
                <li key={p.risk_id}>Remove {p.risk_id}.</li>
              ))}
            </ul>
            {additions.length + removals.length === 0 && (
              <p>The requested permissions are already included. Mark the request as granted.</p>
            )}
            <p>
              This applies to all people and keys. Used calls stay counted. Nothing runs
              automatically.
            </p>
          </>
        }
        confirmLabel={requestId ? 'Add permissions and answer' : 'Change permissions'}
        busy={busy}
        error={error}
        hint="Recorded in the activity."
        onConfirm={() => void save()}
        onCancel={() => setReview(false)}
      />
    </div>
  );
}
