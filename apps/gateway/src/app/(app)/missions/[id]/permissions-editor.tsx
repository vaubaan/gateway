'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Hint, Input } from '@/components/ui';
import type { MissionService } from '@/server/missions/mission-service';
import type { MissionPolicyEntry } from '@vaubaan/shared';
import { useAction, type PostAnswer } from '@/lib/http/post-json';
import { ROW_WORDS } from '@/lib/vocabulary';

import styles from './permissions-editor.styles';

/** What the editor says of a refused change: a conflict, the issues the gateway named, or a reload. */
function refusalOf(answer: Extract<PostAnswer, { ok: false }>): string {
  if (answer.status === 0) return answer.message;
  const body = answer.body as { error?: unknown; issues?: unknown } | null;
  if (body?.error === 'conflict') {
    return 'The mission or request changed. Reload this page and review the current permissions.';
  }
  const issues = Array.isArray(body?.issues)
    ? body.issues
        .map((issue: unknown) =>
          typeof issue === 'object' && issue !== null && 'message' in issue
            ? String(issue.message)
            : '',
        )
        .filter(Boolean)
    : [];
  return issues.join(' ') || 'The change was refused. Reload to check your current access.';
}

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
  const { busy, error, run } = useAction();
  const original = new Map(data.policy.map((p) => [p.risk_id, p]));
  const selected = new Map(policy.map((p) => [p.risk_id, p]));
  const candidates = [
    ...data.candidates,
    ...data.policy
      .filter((p) => !data.candidates.some((c) => c.risk_id === p.risk_id))
      .map((p) => ({
        risk_id: p.risk_id,
        label: p.risk_id,
        row: null,
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
    const answer = await run(
      `/api/missions/${encodeURIComponent(data.missionId)}/permissions`,
      { policy, expected_policy: data.policy, ...(requestId ? { request_id: requestId } : {}) },
      { errorOf: refusalOf },
    );
    if (!answer.ok) return;
    router.push(
      requestId ? `/waiting/${requestId}?decided=1` : `/missions/${data.missionId}#permissions`,
    );
    router.refresh();
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
                      <strong>{c.label}</strong>{' '}
                      {c.row !== null && <span>· {ROW_WORDS[c.row]}</span>}
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
      {requestId && additions.length + removals.length === 0 && (
        <Hint>
          The requested permissions are already included: saving marks the request granted.
        </Hint>
      )}
      <Hint>
        Applies at once to all people and keys; used calls stay counted. Recorded in the activity.
      </Hint>
      <Button
        variant="primary"
        loading={busy}
        disabled={
          busy || invalid || incomplete || (!requestId && additions.length + removals.length === 0)
        }
        onClick={() => void save()}
        data-testid="permissions-save"
      >
        {requestId ? 'Add permissions and answer' : 'Change permissions'}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
