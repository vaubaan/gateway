'use client';

/**
 * What an agent may do on one account (risk model §4.6; ADR
 * macro-actions-and-trust-crans-prefill-the-policy), in two views:
 *
 * - **Simple**: the service's macro-actions, each a row the creator ticks and
 *   sets to a trust cran (Prudent, Confiant, Autonome). Each row says what its
 *   cran yields here: how many run freely, ask first, are left out, and what
 *   the creator may not allow on this account.
 * - **Advanced**: every permission with its own limit and gate (the caller's
 *   `advanced` element, `CustomEditor`).
 *
 * Under both, the policy as it stands, counted, with its highest palier, and
 * "Everything I hold on this account". Whatever is chosen, the mission
 * stores the explicit list; the crans only redraw this panel.
 */
import { Checkbox, ChoiceChip, ChoiceRow, GateMark, TabList, TabPanel } from '@/components/ui';
import {
  CRAN_BUDGET_FACTOR,
  CRAN_HINTS,
  CRAN_LABELS,
  DEFAULT_CRAN,
  TRUST_CRANS,
  type TrustCran,
} from '@/server/missions/macro-actions';
import type { IssuanceConnection } from '@/server/missions/model';

import styles from '../missions.module.css';
import {
  chosenPalier,
  describeEverything,
  explainEverything,
  macroActionRows,
  policyCounts,
  type ConnectionState,
  type MacroActionRow,
  type PolicyView,
} from './form-state';

const VIEWS = [
  { id: 'simple', label: 'Simple' },
  { id: 'advanced', label: 'Advanced' },
] as const;

export function MacroActionPanel({
  connection,
  state,
  advanced,
  onView,
  onCran,
  onEverything,
  onLeaveEverything,
}: {
  connection: IssuanceConnection;
  state: ConnectionState;
  /** The advanced view's content: the permissions one by one. */
  advanced: React.ReactNode;
  onView: (view: PolicyView) => void;
  /** Ticks a macro-action at a cran, moves it, or (`null`) unticks it. */
  onCran: (actionId: string, cran: TrustCran | null) => void;
  /** "Everything I hold on this account". */
  onEverything: () => void;
  /** Back from "Everything I hold" to the macro-actions, none ticked. */
  onLeaveEverything: () => void;
}) {
  const name = `${connection.provider_label} ${connection.display_name}`;
  const base = `view-${connection.id}`;
  const counts = policyCounts(connection, state);
  const total = counts.free + counts.asks;
  const palier = chosenPalier(connection, state);
  const everything = state.everything
    ? describeEverything(connection, explainEverything(connection, state))
    : null;
  const adjusted = state.edited && !state.everything && total > 0;

  return (
    <div className={styles.accountBody} data-testid={`macro-actions-${connection.provider}`}>
      <TabList
        base={base}
        label={`View of the permissions of ${name}`}
        tabs={VIEWS}
        active={state.view}
        onSelect={onView}
      />
      <TabPanel base={base} id={state.view} className={styles.viewPanel}>
        {state.view === 'advanced' ? (
          advanced
        ) : everything ? (
          <div
            className={styles.everythingDescription}
            data-testid={`everything-${connection.provider}`}
          >
            {everything.map((sentence) => (
              <p key={sentence}>{sentence}</p>
            ))}
            <button type="button" className={styles.link} onClick={onLeaveEverything}>
              Back to the macro-actions
            </button>
          </div>
        ) : (
          <>
            {adjusted && (
              <p className={styles.skipped} data-testid={`adjusted-${connection.provider}`}>
                Adjusted in the advanced view: the list no longer matches the crans. Changing a
                macro-action here writes it again from the crans.
              </p>
            )}
            <div className={styles.macroActions}>
              {macroActionRows(connection, state).map((row) => (
                <MacroActionLine
                  key={row.id}
                  connection={connection}
                  row={row}
                  onCran={(cran) => onCran(row.id, cran)}
                />
              ))}
            </div>
          </>
        )}
      </TabPanel>

      <div className={styles.counts} data-testid={`policy-digest-${connection.provider}`}>
        <span>
          <strong>{total}</strong> {total === 1 ? 'permission' : 'permissions'}
        </span>
        <GateMark gate="free">{counts.free} run freely</GateMark>
        {/* Amber is for what will need the person: nothing asks, nothing is coloured. */}
        <GateMark gate={counts.asks === 0 ? 'off' : 'ask'}>
          {counts.asks} {counts.asks === 1 ? 'asks' : 'ask'} you first
        </GateMark>
        {palier !== null && (
          <span
            className={styles.palier}
            data-palier={palier}
            title="Highest palier: 1 mild, 4 irreversible"
          >
            highest palier P{palier}
          </span>
        )}
        {state.everything ? null : (
          <button type="button" className={styles.countsLink} onClick={onEverything}>
            Everything I hold on this account
          </button>
        )}
      </div>
    </div>
  );
}

function MacroActionLine({
  connection,
  row,
  onCran,
}: {
  connection: IssuanceConnection;
  row: MacroActionRow;
  onCran: (cran: TrustCran | null) => void;
}) {
  const ticked = row.cran !== null;
  const id = `macro-${connection.id}-${row.id}`;
  const facts: string[] = [];
  if (row.leftOut > 0) facts.push(`${row.leftOut} left out at ${CRAN_LABELS[row.shownCran]}`);
  if (row.unavailable > 0) facts.push(`${row.unavailable} not available to you here`);
  return (
    <div
      className={[styles.macroAction, ticked ? '' : styles.macroActionOff].join(' ')}
      data-testid={`macro-${connection.provider}-${row.id}`}
    >
      <Checkbox
        id={id}
        checked={ticked}
        disabled={row.empty}
        aria-label={`${row.label} on ${connection.provider_label} ${connection.display_name}`}
        onChange={(event) => onCran(event.target.checked ? DEFAULT_CRAN : null)}
      />
      <div className={styles.macroActionText}>
        <label htmlFor={id} className={styles.macroActionName}>
          {row.label}
        </label>
        <p className={styles.quietText}>{row.description}</p>
        {/* What a cran yields is read once the row is ticked; an empty row says why at once. */}
        {(ticked || row.empty) && (
          <p className={styles.macroActionCounts}>
            {row.total} {row.total === 1 ? 'permission' : 'permissions'}
            {row.empty ? (
              ' · none you may allow here'
            ) : (
              <>
                {' · '}
                <GateMark gate="free">{row.free} run freely</GateMark>{' '}
                <GateMark gate={row.asks > 0 ? 'ask' : 'off'}>{row.asks} ask first</GateMark>
                {facts.length > 0 && ` · ${facts.join(' · ')}`}
                {` · limits ×${CRAN_BUDGET_FACTOR[row.shownCran]}`}
              </>
            )}
          </p>
        )}
      </div>
      <ChoiceRow
        legend={`Cran of ${row.label} on ${connection.provider_label} ${connection.display_name}`}
      >
        {TRUST_CRANS.map((cran) => (
          <ChoiceChip
            key={cran}
            name={`cran-${connection.id}-${row.id}`}
            value={cran}
            checked={row.cran === cran}
            onChange={() => onCran(cran)}
            label={CRAN_LABELS[cran]}
            title={CRAN_HINTS[cran]}
            unavailable={row.empty ? 'none you may allow here' : null}
          />
        ))}
      </ChoiceRow>
    </div>
  );
}
