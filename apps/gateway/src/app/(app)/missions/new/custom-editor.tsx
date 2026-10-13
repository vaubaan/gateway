'use client';

/**
 * Custom mode of one connection (spec §4.2): the granular editor. Every
 * explicit risk id of the plugin's catalog is listed — reads, writes,
 * irreversible writes — with its label, why it is a risk, its six-axis vector
 * and its environment; the ones the creator holds can be ticked and get a
 * quota, a rate limit and a gate; the ones they do not hold, or that no
 * selected resource can resolve, are shown with the reason and cannot be
 * ticked. "Start from preset…" pre-fills; a long catalog gets a search box.
 */
import { useMemo, useState } from 'react';

import { RiskExplain, RiskMarkerNotes, RiskMarkers } from '@/components/risk/RiskExplain';
import { Input, Select } from '@/components/ui';
import { groupByKind, type RiskFamily } from '@/server/missions/catalog-view';
import type { IssuanceConnection } from '@/server/missions/model';
import { providerPath, REFERENCE_SECTIONS } from '@/server/providers/links';

import styles from '../missions.module.css';
import {
  clearAll,
  dropUnresolvable,
  editorRows,
  filterRows,
  RISK_FILTERS,
  SEARCH_THRESHOLD,
  selectAll,
  toggleRisk,
  updateEntry,
  type ConnectionState,
  type EditorRow,
  type RiskFilter,
} from './form-state';
import { GATE_LABELS } from './labels';

function isFilter(raw: string): raw is RiskFilter {
  return RISK_FILTERS.some((f) => f.id === raw);
}

export function CustomEditor({
  connection,
  state,
  onChange,
  onStartFrom,
}: {
  connection: IssuanceConnection;
  state: ConnectionState;
  onChange: (next: ConnectionState) => void;
  /** "Start from preset…": the screen decides whether edits must be confirmed away first. */
  onStartFrom: (presetId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RiskFilter>('all');
  const name = `${connection.provider_label} ${connection.display_name}`;
  const rows = useMemo(() => editorRows(connection, state), [connection, state]);
  const shown = filterRows(rows, query, filter);
  const byId = new Map(rows.map((row) => [row.risk.risk_id, row]));
  const groups = groupByKind(shown.map((row) => row.risk));
  const accepted = rows.filter((row) => row.accepted).length;
  const available = rows.filter((row) => row.unavailable === null).length;
  const refused = rows.filter((row) => row.accepted && row.unavailable !== null).length;
  const searchable = rows.length > SEARCH_THRESHOLD;

  return (
    <div className={styles.policyBody} data-testid={`risks-${connection.provider}`}>
      <div className={styles.riskTools}>
        <Select
          value=""
          aria-label={`Start from a preset for ${name}`}
          onChange={(e) => {
            if (e.target.value) onStartFrom(e.target.value);
          }}
        >
          <option value="">Start from preset…</option>
          {connection.presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </Select>
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
        {refused > 0 && (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => onChange(dropUnresolvable(connection, state))}
          >
            Remove the {refused} refused
          </button>
        )}
        <span className={styles.muted} data-testid={`risks-count-${connection.provider}`}>
          {accepted} accepted of {available} you can accept here
        </span>
      </div>
      <p className={styles.toolsNote}>
        “Select all” ticks each risk you hold, one by one; it leaves out deprecated entries and the
        uncategorized-write fallback. Each id links to its entry in the{' '}
        <a
          href={`${providerPath(connection.provider)}#${REFERENCE_SECTIONS.risks}`}
          target="_blank"
          rel="noreferrer"
          className={styles.refLink}
        >
          {connection.provider_label} reference
        </a>{' '}
        (new tab), where the six badges are explained.
      </p>

      {searchable && (
        <div className={styles.riskSearch}>
          <Input
            type="search"
            value={query}
            placeholder="Search by name, id, environment, reason…"
            aria-label={`Search the risks of ${name}`}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Select
            value={filter}
            aria-label={`Show which risks of ${name}`}
            onChange={(e) => {
              if (isFilter(e.target.value)) setFilter(e.target.value);
            }}
          >
            {RISK_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
          <span className={styles.muted} aria-live="polite">
            {shown.length} of {rows.length} shown
          </span>
        </div>
      )}

      {groups.length === 0 && <p className={styles.muted}>No risk matches.</p>}

      {groups.map((group) => (
        <section key={group.kind} aria-label={`${group.title} of ${name}`}>
          <h3 className={styles.kindTitle}>
            {group.title}{' '}
            <span className={styles.count}>
              (
              {
                group.families
                  .flatMap((f) => f.variants)
                  .filter((r) => byId.get(r.risk_id)?.accepted).length
              }{' '}
              of {group.families.flatMap((f) => f.variants).length} accepted)
            </span>
            <span className={styles.kindHint}>{group.hint}</span>
          </h3>
          <div className={styles.familyStack}>
            {group.families.map((family) => (
              <FamilyRows
                key={family.base_id}
                family={family}
                rows={byId}
                connection={connection}
                state={state}
                onChange={onChange}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * One catalog entry. An account-scoped entry is one row. An env-scoped entry
 * states its label and its reason once, then one row per environment: each is
 * an explicit id with its own vector, ticked and budgeted on its own.
 */
function FamilyRows({
  family,
  rows,
  connection,
  state,
  onChange,
}: {
  family: RiskFamily;
  rows: ReadonlyMap<string, EditorRow>;
  connection: IssuanceConnection;
  state: ConnectionState;
  onChange: (next: ConnectionState) => void;
}) {
  const perEnv = family.variants.some((risk) => risk.env !== null);
  return (
    <div className={styles.family} data-family={family.base_id}>
      {perEnv && (
        <div className={styles.familyHead}>
          <span className={styles.familyLabel}>
            {family.label} <RiskMarkers fallback={family.fallback} deprecated={family.deprecated} />
            <span className={styles.muted}>accepted per environment</span>
          </span>
          <span className={styles.familyReason}>{family.reason}</span>
          <RiskMarkerNotes fallback={family.fallback} deprecated={family.deprecated} />
        </div>
      )}
      {family.variants.map((risk) => {
        const row = rows.get(risk.risk_id);
        if (!row) return null;
        return (
          <VariantRow
            key={risk.risk_id}
            row={row}
            standalone={!perEnv}
            connection={connection}
            state={state}
            onChange={onChange}
          />
        );
      })}
    </div>
  );
}

function VariantRow({
  row,
  standalone,
  connection,
  state,
  onChange,
}: {
  row: EditorRow;
  standalone: boolean;
  connection: IssuanceConnection;
  state: ConnectionState;
  onChange: (next: ConnectionState) => void;
}) {
  const { risk, unavailable } = row;
  const entry = state.entries[risk.risk_id];
  const id = `${connection.id}:${risk.risk_id}`;
  // A row that cannot be ticked stays listed; one that is ticked can always be unticked.
  const locked = unavailable !== null && entry === undefined;
  return (
    <div
      className={[styles.riskRow, locked ? styles.riskRowOff : ''].join(' ')}
      data-risk={risk.risk_id}
    >
      <input
        id={id}
        type="checkbox"
        checked={entry !== undefined}
        disabled={locked}
        aria-label={`Accept risk ${risk.risk_id}`}
        aria-describedby={unavailable !== null ? `${id}:why` : undefined}
        onChange={() => onChange(toggleRisk(connection, state, risk))}
      />
      <div className={styles.riskCell}>
        <RiskExplain risk={risk} newTab labelFor={id} label={standalone} reason={standalone} />
        {unavailable !== null && (
          <span id={`${id}:why`} className={entry ? styles.refused : styles.unavailableWhy}>
            {entry ? 'Refused at issuance' : 'Not available'}: {unavailable}
          </span>
        )}
      </div>
      {entry ? (
        <div className={styles.budget}>
          <label className={styles.budgetField}>
            <span>Quota</span>
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
          </label>
          <div className={styles.budgetField}>
            <span>Rate limit</span>
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
          </div>
          <label className={styles.budgetField}>
            <span>Gate</span>
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
          </label>
        </div>
      ) : (
        <div className={styles.budgetOff}>
          {locked ? '' : 'Tick to accept it and set its quota, rate limit and gate.'}
        </div>
      )}
    </div>
  );
}
