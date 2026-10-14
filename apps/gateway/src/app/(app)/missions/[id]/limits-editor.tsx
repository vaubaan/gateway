'use client';

/**
 * "Change limits" on a mission (spec §3.2; ADR mission-limits-editable-after-issuance):
 * the permission table of the mission in edit mode, for its limits only. Each
 * permission the mission holds keeps its row; its limit per period and its calls per
 * minute (or per its own window) become fields. Nothing else is offered: a permission
 * is neither added nor removed here, the period and "ask me first" do not move.
 *
 * "Review the change" opens a confirmation that lists what changes, before and after,
 * and says what a lower limit does to what was already used. The instance judges the
 * change again with the rule of a creation and answers what it refuses.
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import {
  Button,
  ButtonLink,
  ConfirmDialog,
  EnvTag,
  Hint,
  Input,
  PermissionGroup,
  PermissionRow,
  PermissionTable,
  useToast,
} from '@/components/ui';
import { ACTIONS, formatNumber, gateWordOf, WAITING, type SeverityWord } from '@/lib/vocabulary';
import type { Gate } from '@vaubaan/shared';

import { messageOf } from '../message-of';
import styles from '../missions.module.css';

const SECONDS_PER_MINUTE = 60;

/** One permission of the mission, as the editor needs it: plain data. */
export interface LimitRow {
  readonly risk_id: string;
  readonly label: string;
  readonly level: SeverityWord;
  readonly env: string | null;
  readonly quota: number;
  readonly rate_max: number;
  readonly rate_window_seconds: number;
  readonly gate: Gate;
  /** Used in the current period; `null` when the mission serves no call now. */
  readonly used: number | null;
}

export interface LimitGroup {
  readonly key: string;
  readonly title: string;
  readonly note: string;
  readonly rows: readonly LimitRow[];
}

interface Draft {
  readonly quota: string;
  readonly rate: string;
}

/** A whole number of at least one, or `null`. */
function wholeOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function windowWords(seconds: number): string {
  return seconds === SECONDS_PER_MINUTE ? 'a minute' : `per ${formatNumber(seconds)} s`;
}

export function LimitsEditor({
  missionId,
  missionName,
  groups,
  limitLabel,
  periodWord,
  resetWords,
  missionPath,
}: {
  missionId: string;
  missionName: string;
  groups: readonly LimitGroup[];
  /** The head of the limit column: "Per day", "Per week", "In total". */
  limitLabel: string;
  /** "today", "this week": the period a count belongs to. */
  periodWord: string;
  /** When the limits reset: "at the reset (15 Oct, 00:00)", or `null` when they never do. */
  resetWords: string | null;
  missionPath: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>(() =>
    Object.fromEntries(
      rows.map((r) => [r.risk_id, { quota: String(r.quota), rate: String(r.rate_max) }]),
    ),
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftOf = (row: LimitRow): Draft =>
    drafts[row.risk_id] ?? { quota: String(row.quota), rate: String(row.rate_max) };
  const invalid = rows.filter((row) => {
    const d = draftOf(row);
    return wholeOf(d.quota) === null || wholeOf(d.rate) === null;
  });
  const changes = rows.flatMap((row) => {
    const d = draftOf(row);
    const quota = wholeOf(d.quota);
    const rate = wholeOf(d.rate);
    if (quota === null || rate === null) return [];
    if (quota === row.quota && rate === row.rate_max) return [];
    return [{ row, quota, rate }];
  });
  const overUsed = changes.filter(({ row, quota }) => row.used !== null && row.used >= quota);

  function set(riskId: string, field: keyof Draft, value: string) {
    setDrafts((current) => {
      const before = current[riskId] ?? { quota: '', rate: '' };
      return { ...current, [riskId]: { ...before, [field]: value } };
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          limits: changes.map(({ row, quota, rate }) => ({
            risk_id: row.risk_id,
            quota,
            rate_limit: { max: rate },
          })),
        }),
      });
      if (!res.ok) {
        setError(messageOf(await res.json().catch(() => null), res.status));
        return;
      }
      setConfirming(false);
      toast({
        title: changes.length === 1 ? 'Limit changed' : `${changes.length} limits changed`,
        description: 'From the next call. What was used stays used.',
      });
      router.push(`${missionPath}#permissions`);
      router.refresh();
    } catch {
      setError('The gateway could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="limits-editor">
      <PermissionTable
        variant="read"
        caption={`Limits of ${missionName}, being changed`}
        labels={{ limit: limitLabel }}
        testId="limits-table"
      >
        {groups.map((group) => (
          <PermissionGroup key={group.key} title={group.title} note={group.note}>
            {group.rows.map((row) => {
              const d = draftOf(row);
              const perMinute = row.rate_window_seconds === SECONDS_PER_MINUTE;
              return (
                <PermissionRow
                  key={row.risk_id}
                  label={
                    <>
                      {row.label}
                      {row.used !== null && (
                        <span className={styles.unavailableWhy}>
                          {formatNumber(row.used)} used {periodWord}
                        </span>
                      )}
                    </>
                  }
                  id={row.risk_id}
                  severity={row.level}
                  tag={row.env ? <EnvTag env={row.env} /> : undefined}
                  perDay={
                    <Input
                      size="sm"
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      className={styles.limitInput}
                      value={d.quota}
                      aria-label={`Limit for ${row.risk_id}`}
                      aria-invalid={wholeOf(d.quota) === null}
                      onChange={(e) => set(row.risk_id, 'quota', e.target.value)}
                      data-testid={`limit-quota-${row.risk_id}`}
                    />
                  }
                  perMinute={
                    <span className={styles.rate}>
                      <Input
                        size="sm"
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        className={styles.limitInput}
                        value={d.rate}
                        aria-label={
                          perMinute
                            ? `Per minute for ${row.risk_id}`
                            : `Calls per ${row.rate_window_seconds} seconds for ${row.risk_id}`
                        }
                        aria-invalid={wholeOf(d.rate) === null}
                        onChange={(e) => set(row.risk_id, 'rate', e.target.value)}
                        data-testid={`limit-rate-${row.risk_id}`}
                      />
                      {!perMinute && <span>per {row.rate_window_seconds} s</span>}
                    </span>
                  }
                  gate={gateWordOf(row.gate)}
                />
              );
            })}
          </PermissionGroup>
        ))}
      </PermissionTable>
      <div className={styles.limitsActions}>
        <Button
          type="button"
          variant="primary"
          disabled={changes.length === 0 || invalid.length > 0}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          data-testid="limits-review"
        >
          Review the change
        </Button>
        <ButtonLink href={`${missionPath}#permissions`} variant="ghost">
          {ACTIONS.cancel}
        </ButtonLink>
        <Hint>
          {invalid.length > 0
            ? 'Each limit is a whole number of at least 1.'
            : 'Only the limits move: the permissions, what asks first and the period stay as they are.'}
        </Hint>
      </div>

      <ConfirmDialog
        open={confirming}
        title={
          changes.length === 1
            ? 'Change the limit of 1 permission?'
            : `Change the limits of ${changes.length} permissions?`
        }
        consequence={
          <>
            <ul className={styles.limitChanges} data-testid="limits-changes">
              {changes.map(({ row, quota, rate }) => (
                <li key={row.risk_id}>
                  <strong>{row.label}</strong> <code>{row.risk_id}</code>
                  <br />
                  {quota !== row.quota && (
                    <>
                      {limitLabel.toLowerCase()}: {formatNumber(row.quota)} → {formatNumber(quota)}
                      {rate !== row.rate_max ? ' · ' : ''}
                    </>
                  )}
                  {rate !== row.rate_max && (
                    <>
                      calls {windowWords(row.rate_window_seconds)}: {formatNumber(row.rate_max)} →{' '}
                      {formatNumber(rate)}
                    </>
                  )}
                </li>
              ))}
            </ul>
            <p>
              The new limits apply <strong>from the next call</strong>, in the current period. What
              was used stays used.
              {overUsed.length > 0 &&
                ` ${overUsed.map(({ row }) => `“${row.label}”`).join(', ')} ${
                  overUsed.length === 1 ? 'has' : 'have'
                } already used ${overUsed.length === 1 ? 'its' : 'their'} new limit: ${
                  overUsed.length === 1 ? 'it stops' : 'they stop'
                } ${resetWords ?? 'for good, unless you raise the limit again'}.`}
            </p>
          </>
        }
        confirmLabel="Change limits"
        busy={busy}
        error={error}
        hint={WAITING.recorded}
        onConfirm={() => void save()}
        onCancel={() => setConfirming(false)}
        testId="limits-confirm"
      />
    </div>
  );
}
