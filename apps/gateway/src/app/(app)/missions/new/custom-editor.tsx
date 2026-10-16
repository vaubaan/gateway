'use client';

/**
 * The granular editor of one account (spec §4.2): the permissions one by one.
 * Every explicit id of the service's catalog is a row — reads, writes,
 * irreversible writes — with what it allows in words, its id, its severity,
 * its limit per period and per minute, whether it asks first, and "why?" (the
 * reason, the six words of the risk model, its entry in the reference).
 *
 * By default the editor shows what the reader may allow here; what they may
 * not, or what no selected resource can carry, is one filter away, listed
 * with the reason and without a tick. A long catalog can be searched, and a
 * service with several planes can be sliced by one.
 */
import { useMemo, useState } from 'react';

import {
  Checkbox,
  EnvTag,
  Input,
  PermissionGroup,
  PermissionRow,
  PermissionTable,
  SearchField,
  Segmented,
  Select,
  Switch,
  Tag,
} from '@/components/ui';
import { GATE_WORDS, gateWordOf } from '@/lib/vocabulary';
import {
  DEPRECATED_NOTE,
  FALLBACK_NOTE,
  groupByKind,
  noteBody,
} from '@/server/missions/catalog-view';
import type { IssuanceConnection } from '@/server/missions/model';
import { riskReferencePath } from '@/server/providers/links';
import type { RiskPlanes } from '@/server/providers/planes';

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

/** Every plane at once: the plane filter when nothing is sliced. */
const ALL_PLANES = 'all';
const SECONDS_PER_MINUTE = '60';

export function CustomEditor({
  connection,
  state,
  planes,
  limitLabel,
  onChange,
  onReset,
}: {
  connection: IssuanceConnection;
  state: ConnectionState;
  /** The planes of the service's data model, when it has several: the editor can be sliced by one. */
  planes: RiskPlanes | null;
  /** The head of the limit column: "Per day", "Per week", "In total". */
  limitLabel: string;
  onChange: (next: ConnectionState) => void;
  /** "Reset to the preset": the screen asks first, then drops the edits. `null`: nothing to reset. */
  onReset: (() => void) | null;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RiskFilter>('available');
  const [plane, setPlane] = useState(ALL_PLANES);
  /** Rows whose rate window is edited apart from "per minute". */
  const [windows, setWindows] = useState<ReadonlySet<string>>(new Set());
  const name = `${connection.provider_label} ${connection.display_name}`;
  const rows = useMemo(() => editorRows(connection, state), [connection, state]);
  const shown = filterRows(rows, query, filter).filter(
    (row) =>
      planes === null ||
      plane === ALL_PLANES ||
      (planes.by_risk[row.risk.base_id] ?? []).includes(plane),
  );
  const byId = new Map(rows.map((row) => [row.risk.risk_id, row]));
  const groups = groupByKind(shown.map((row) => row.risk));
  const accepted = rows.filter((row) => row.accepted).length;
  const available = rows.filter((row) => row.unavailable === null).length;
  const refused = rows.filter((row) => row.accepted && row.unavailable !== null).length;
  const searchable = rows.length > SEARCH_THRESHOLD || planes !== null;

  return (
    <div className={styles.editor} data-testid={`risks-${connection.provider}`}>
      <div className={styles.editorTools}>
        {searchable && (
          <SearchField
            label={`Search the permissions of ${name}`}
            placeholder="Filter…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        {planes !== null && (
          <Select
            size="sm"
            className={styles.planeSelect}
            value={plane}
            aria-label={`Plane of the permissions of ${name}`}
            onChange={(event) => setPlane(event.target.value)}
          >
            <option value={ALL_PLANES}>All planes</option>
            {planes.planes.map((slug) => (
              <option key={slug} value={slug}>
                Plane: {slug}
              </option>
            ))}
          </Select>
        )}
        <span className={styles.editorFilter}>
          <Segmented
            label={`Which permissions of ${name} to show`}
            options={RISK_FILTERS.map((f) => ({ value: f.id, label: f.label }))}
            value={filter}
            onChange={setFilter}
          />
        </span>
      </div>
      <div className={styles.editorBulk}>
        <span data-testid={`risks-count-${connection.provider}`}>
          {accepted} chosen of {available} you may allow here
        </span>
        <button
          type="button"
          className={styles.link}
          onClick={() => onChange(selectAll(connection, state))}
        >
          Select all
        </button>
        <button type="button" className={styles.link} onClick={() => onChange(clearAll(state))}>
          Clear
        </button>
        {refused > 0 && (
          <button
            type="button"
            className={styles.link}
            onClick={() => onChange(dropUnresolvable(connection, state))}
          >
            Remove the {refused} that would be refused
          </button>
        )}
        {onReset && (
          <button type="button" className={styles.link} onClick={onReset}>
            Reset to the preset
          </button>
        )}
        <span className={styles.editorShown} aria-live="polite">
          {shown.length} of {rows.length} shown
        </span>
      </div>

      {groups.length === 0 ? (
        <p className={styles.quiet}>No permission matches.</p>
      ) : (
        <PermissionTable
          variant="editor"
          caption={`Permissions on ${name}`}
          labels={{ limit: limitLabel }}
        >
          {groups.map((group) => {
            const variants = group.families.flatMap((family) => family.variants);
            const chosen = variants.filter((risk) => byId.get(risk.risk_id)?.accepted).length;
            return (
              <PermissionGroup
                key={group.kind}
                title={group.title}
                note={`${group.hint} ${chosen} of ${variants.length} chosen.`}
              >
                {variants.map((risk) => {
                  const row = byId.get(risk.risk_id);
                  return row ? (
                    <EditorRowView
                      key={risk.risk_id}
                      row={row}
                      connection={connection}
                      state={state}
                      ownWindow={windows.has(risk.risk_id)}
                      onOwnWindow={() =>
                        setWindows((current) => new Set(current).add(risk.risk_id))
                      }
                      onChange={onChange}
                    />
                  ) : null;
                })}
              </PermissionGroup>
            );
          })}
        </PermissionTable>
      )}
    </div>
  );
}

function EditorRowView({
  row,
  connection,
  state,
  ownWindow,
  onOwnWindow,
  onChange,
}: {
  row: EditorRow;
  connection: IssuanceConnection;
  state: ConnectionState;
  ownWindow: boolean;
  onOwnWindow: () => void;
  onChange: (next: ConnectionState) => void;
}) {
  const { risk, unavailable } = row;
  const entry = state.entries[risk.risk_id];
  // A row that cannot be ticked stays listed; one that is ticked can always be unticked.
  const locked = unavailable !== null && entry === undefined;
  const perMinute = entry?.rateWindow === SECONDS_PER_MINUTE && !ownWindow;
  const reference = riskReferencePath(risk.risk_id);

  return (
    <PermissionRow
      label={
        <>
          {risk.label}
          {unavailable !== null && (
            <span
              className={entry ? styles.refusedWhy : styles.unavailableWhy}
              data-testid={`unavailable-${risk.risk_id}`}
            >
              {entry ? 'Would be refused' : 'Not available'}: {unavailable}
            </span>
          )}
        </>
      }
      id={risk.risk_id}
      severity={risk.level}
      included={entry !== undefined}
      tag={
        risk.env || risk.fallback || risk.deprecated ? (
          <>
            {risk.env && <EnvTag env={risk.env} />}
            {risk.fallback && <Tag tone="warn">fallback</Tag>}
            {risk.deprecated && <Tag tone="warn">deprecated</Tag>}
          </>
        ) : undefined
      }
      select={
        <Checkbox
          checked={entry !== undefined}
          disabled={locked}
          aria-label={`Allow ${risk.risk_id}`}
          onChange={() => onChange(toggleRisk(connection, state, risk))}
        />
      }
      perDay={
        entry && (
          <Input
            size="sm"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className={styles.limitInput}
            value={entry.quota}
            aria-label={`Limit for ${risk.risk_id}`}
            aria-invalid={entry.quota.trim() === ''}
            onChange={(e) => onChange(updateEntry(state, risk.risk_id, { quota: e.target.value }))}
          />
        )
      }
      perMinute={
        entry && (
          <span className={styles.rate}>
            <Input
              size="sm"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              className={styles.limitInput}
              value={entry.rateMax}
              aria-label={
                perMinute
                  ? `Per minute for ${risk.risk_id}`
                  : `Calls per window for ${risk.risk_id}`
              }
              aria-invalid={entry.rateMax.trim() === ''}
              onChange={(e) =>
                onChange(updateEntry(state, risk.risk_id, { rateMax: e.target.value }))
              }
            />
            {!perMinute && (
              <>
                <span>per</span>
                <Input
                  size="sm"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  className={styles.windowInput}
                  value={entry.rateWindow}
                  aria-label={`Window in seconds for ${risk.risk_id}`}
                  onChange={(e) =>
                    onChange(updateEntry(state, risk.risk_id, { rateWindow: e.target.value }))
                  }
                />
                <span>s</span>
              </>
            )}
          </span>
        )
      }
      gate={entry ? gateWordOf(entry.gate) : 'off'}
      gateControl={
        entry && (
          <Switch
            checked={entry.gate === 'approval'}
            aria-label={`${GATE_WORDS.ask}: ${risk.risk_id}`}
            onChange={(e) =>
              onChange(
                updateEntry(state, risk.risk_id, { gate: e.target.checked ? 'approval' : 'auto' }),
              )
            }
          />
        )
      }
      why={{
        reason: (
          <>
            {risk.reason}
            {risk.fallback && ` ${noteBody(FALLBACK_NOTE)}`}
            {risk.deprecated && ` ${noteBody(DEPRECATED_NOTE)}`}
            {reference && (
              <>
                {' '}
                {/* A new tab: leaving the page would lose what was typed in the form. */}
                <a href={reference} target="_blank" rel="noreferrer" className={styles.link}>
                  Full entry in the reference (new tab)
                </a>
              </>
            )}
            {entry && perMinute && (
              <span className={styles.ownLine}>
                <button type="button" className={styles.link} onClick={onOwnWindow}>
                  Count it over another window than a minute
                </button>
              </span>
            )}
          </>
        ),
        cells: risk.vector,
      }}
    />
  );
}
