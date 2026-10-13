/**
 * "Permissions and usage" of a mission: the explicit list a key carries, with
 * what was used in the current period and what is left — one row per
 * permission, grouped by account. Each row says in words what it allows,
 * prints its id as the protocol spells it, and keeps "why?" one click away
 * (the reason, the six words of the risk model, the entry in the reference).
 *
 * The creator changes "ask me first" on a row here, when the server would
 * take the change (`MissionDetail.gates_editable`); anyone else reads it.
 */
import { LocalDate } from '@/components/LocalDate';
import {
  EnvTag,
  Meter,
  meterState,
  PermissionGroup,
  PermissionRow,
  PermissionTable,
} from '@/components/ui';
import { formatNumber, gateWordOf, listed, usage, usedColumn } from '@/lib/vocabulary';
import type { MissionDetail } from '@/server/missions';
import type { CatalogRisk } from '@/server/missions/model';
import { riskReferencePath } from '@/server/providers/links';
import { parseRiskId } from '@vaubaan/shared';

import styles from '../missions.module.css';
import { perMinuteOf } from '../mission-view';
import { GateControl } from './gate-control';

export function PermissionsUsage({
  detail,
  explain,
  periodSeconds,
  editable,
}: {
  detail: Pick<MissionDetail, 'mission' | 'policy' | 'connections'>;
  /** The catalog row behind an id: what the permission means, not only what it is called. */
  explain: (riskId: string) => CatalogRisk | null;
  /** The length of the mission's period; `null` for limits that never reset. */
  periodSeconds: number | null;
  /** The reader may change "ask me first" now. */
  editable: boolean;
}) {
  const { mission, policy, connections } = detail;
  const groups = connections
    .map((connection) => ({
      connection,
      entries: policy.filter(
        (entry) => parseRiskId(entry.risk_id)?.provider === connection.provider,
      ),
    }))
    .filter((group) => group.entries.length > 0);
  const grouped = new Set(groups.flatMap((group) => group.entries.map((e) => e.risk_id)));
  const orphans = policy.filter((entry) => !grouped.has(entry.risk_id));

  const rowOf = (entry: (typeof policy)[number]) => {
    const risk = explain(entry.risk_id);
    const used = entry.remaining === null ? null : entry.quota - entry.remaining;
    return (
      <PermissionRow
        key={entry.risk_id}
        label={entry.label}
        id={entry.risk_id}
        severity={entry.level ?? 'low'}
        tag={
          risk?.env || entry.gate_open_until ? (
            <>
              {risk?.env && <EnvTag env={risk.env} />}
              {entry.gate_open_until && (
                <span className={styles.openUntil} data-testid={`gate-open-${entry.risk_id}`}>
                  runs freely until <LocalDate ts={entry.gate_open_until} />
                </span>
              )}
            </>
          ) : undefined
        }
        usage={
          used === null ? (
            <span className={styles.quietText}>limit {formatNumber(entry.quota)}</span>
          ) : meterState(used, entry.quota) === 'far' ? (
            // A bar only where a limit is near: far from it, the figure is enough.
            <span className={styles.figure}>{usage(used, entry.quota)}</span>
          ) : (
            <Meter used={used} limit={entry.quota} />
          )
        }
        perMinute={perMinuteOf(entry.rate_limit)}
        gate={gateWordOf(entry.gate)}
        gateControl={
          editable ? (
            <GateControl
              missionId={mission.id}
              riskId={entry.risk_id}
              label={entry.label}
              gate={entry.gate}
            />
          ) : undefined
        }
        why={
          risk
            ? {
                reason: risk.reason,
                cells: risk.vector,
                referenceHref: riskReferencePath(entry.risk_id) ?? undefined,
              }
            : undefined
        }
      />
    );
  };

  return (
    <PermissionTable
      variant="usage"
      caption={`Permissions of ${mission.name}, with what was used`}
      labels={{ usage: usedColumn(periodSeconds) }}
      testId="permissions-table"
    >
      {groups.map(({ connection, entries }) => (
        <PermissionGroup
          key={connection.id}
          title={`${connection.provider_label} · ${connection.display_name}`}
          note={
            connection.resources.length === 0
              ? 'the account itself, no resource'
              : listed(
                  connection.resources.map((r) => r.display_name || r.ref),
                  3,
                )
          }
        >
          {entries.map(rowOf)}
        </PermissionGroup>
      ))}
      {orphans.length > 0 && (
        <PermissionGroup title="Other" note="no account of this mission carries them">
          {orphans.map(rowOf)}
        </PermissionGroup>
      )}
    </PermissionTable>
  );
}
