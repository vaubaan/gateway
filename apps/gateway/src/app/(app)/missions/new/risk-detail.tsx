'use client';

/**
 * Per-risk detail of one connection — folded by default (spec §4.2). Unfolded
 * it lists every risk the creator holds that the selected resources can
 * resolve, with its quota, rate limit and gate; what the selection cannot
 * resolve, or the creator does not hold, is shown and cannot be ticked.
 */
import { GATE_LABELS } from './labels';
import {
  clearAll,
  dropUnresolvable,
  selectAll,
  selectedResources,
  toggleRisk,
  unavailableReason,
  updateEntry,
  type ConnectionState,
} from './form-state';
import styles from '../missions.module.css';

import { Badge, Input, Select, type BadgeTone } from '@/components/ui';
import type { CatalogRisk, IssuanceConnection, SeverityLevel } from '@/server/missions/model';

const LEVEL_TONE: Record<SeverityLevel, BadgeTone> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

export function RiskDetail({
  connection,
  state,
  onChange,
}: {
  connection: IssuanceConnection;
  state: ConnectionState;
  onChange: (next: ConnectionState) => void;
}) {
  const held = new Set(connection.authority);
  const resources = selectedResources(connection, state);
  const rows: { risk: CatalogRisk; reason: string | null }[] = connection.risks.map((risk) => ({
    risk,
    reason: unavailableReason(connection, risk, resources, held),
  }));
  // A row is listed when it can be ticked, or when it is ticked although it no longer can.
  const listed = rows.filter((r) => r.reason === null || state.entries[r.risk.risk_id]);
  const unavailable = rows.filter((r) => r.reason !== null && !state.entries[r.risk.risk_id]);
  const stale = listed.filter((r) => r.reason !== null);
  const name = `${connection.provider_label} ${connection.display_name}`;

  return (
    <div className={styles.foldBody}>
      <div className={styles.riskTools}>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => onChange(selectAll(connection, state))}
        >
          Select all
        </button>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => onChange(clearAll(state))}
        >
          Clear
        </button>
        {stale.length > 0 && (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => onChange(dropUnresolvable(connection, state))}
          >
            Remove the {stale.length} refused
          </button>
        )}
        <span className={styles.muted}>
          “Select all” ticks each risk you hold, one by one; it leaves out deprecated entries and
          the uncategorized-write fallback.
        </span>
      </div>

      <div className={styles.riskGrid} role="table" aria-label={`Risks of ${name}`}>
        <div className={styles.riskHead}>Risk</div>
        <div className={styles.riskHead}>Quota</div>
        <div className={styles.riskHead}>Rate limit</div>
        <div className={styles.riskHead}>Gate</div>
        {listed.map(({ risk, reason }) => {
          const entry = state.entries[risk.risk_id];
          const id = `${connection.id}:${risk.risk_id}`;
          return (
            <div key={risk.risk_id} style={{ display: 'contents' }} data-risk={risk.risk_id}>
              <label className={styles.riskLabel} htmlFor={id} title={risk.reason}>
                <input
                  id={id}
                  type="checkbox"
                  checked={entry !== undefined}
                  aria-label={`Accept risk ${risk.risk_id}`}
                  onChange={() => onChange(toggleRisk(connection, state, risk))}
                />
                <span className={styles.riskText}>
                  <span>
                    {risk.label} <Badge tone={LEVEL_TONE[risk.level]}>{risk.level}</Badge>
                    {risk.env && <Badge mono>{risk.env}</Badge>}
                    {risk.fallback && <Badge tone="warning">fallback</Badge>}
                    {risk.deprecated && <Badge tone="warning">deprecated</Badge>}
                  </span>
                  <span className={styles.mono}>{risk.risk_id}</span>
                  {reason !== null && <span className={styles.refused}>Refused: {reason}</span>}
                </span>
              </label>
              {entry ? (
                <>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={entry.quota}
                    aria-label={`Quota for ${risk.risk_id}`}
                    aria-invalid={entry.quota.trim() === ''}
                    onChange={(e) =>
                      onChange(updateEntry(state, risk.risk_id, { quota: e.target.value }))
                    }
                  />
                  <div className={styles.rate}>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={entry.rateMax}
                      aria-label={`Rate limit for ${risk.risk_id}`}
                      onChange={(e) =>
                        onChange(updateEntry(state, risk.risk_id, { rateMax: e.target.value }))
                      }
                    />
                    <span>per</span>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={entry.rateWindow}
                      aria-label={`Rate window in seconds for ${risk.risk_id}`}
                      onChange={(e) =>
                        onChange(updateEntry(state, risk.risk_id, { rateWindow: e.target.value }))
                      }
                    />
                    <span>s</span>
                  </div>
                  <Select
                    value={entry.gate}
                    aria-label={`Gate for ${risk.risk_id}`}
                    onChange={(e) =>
                      onChange(
                        updateEntry(state, risk.risk_id, {
                          gate: e.target.value === 'approval' ? 'approval' : 'auto',
                        }),
                      )
                    }
                  >
                    <option value="auto">{GATE_LABELS.auto}</option>
                    <option value="approval">{GATE_LABELS.approval}</option>
                  </Select>
                </>
              ) : (
                <>
                  <span />
                  <span />
                  <span />
                </>
              )}
            </div>
          );
        })}
      </div>

      {unavailable.length > 0 && (
        <details className={styles.unavailable}>
          <summary>
            {unavailable.length} {unavailable.length === 1 ? 'entry' : 'entries'} unavailable with
            this selection
          </summary>
          <ul>
            {unavailable.map(({ risk, reason }) => (
              <li key={risk.risk_id}>
                <span className={styles.mono}>{risk.risk_id}</span> — {risk.label}: {reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
