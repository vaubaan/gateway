'use client';

/**
 * What an agent may do on one account (risk model §4.6; ADR
 * macro-actions-and-trust-levels-prefill-the-policy), in two views:
 *
 * - **Simple**: the service's macro-actions, each a row the creator ticks and
 *   sets to a trust level (Careful, Trusting, Autonomous). Each row says what its
 *   trust level yields here: how many run freely, ask first, are left out, and what
 *   the creator may not allow on this account.
 * - **Advanced**: every permission with its own limit and gate (the caller's
 *   `advanced` element, `CustomEditor`).
 *
 * Under both, the policy as it stands, counted, with its highest tier, and
 * "Everything I hold on this account". Whatever is chosen, the mission
 * stores the explicit list; the trust levels only redraw this panel.
 *
 * The two views are the account's (`MacroActionPanel`); what they show is one
 * resource set's (`SetPolicy`), once per set when the account has several (risk
 * model §4.7), each with its own trust levels.
 */
import { Checkbox, ChoiceChip, ChoiceRow, GateMark, TabList, TabPanel } from '@/components/ui';
import { TRUST_LEVEL_HINTS, TRUST_LEVEL_LABELS } from '@/lib/vocabulary';
import {
  TRUST_LEVEL_BUDGET_FACTOR,
  DEFAULT_TRUST_LEVEL,
  TRUST_LEVELS,
  type TrustLevel,
} from '@/lib/missions/macro-actions';
import type { IssuanceConnection } from '@/lib/missions/model';

import styles from '../missions.module.css';
import {
  chosenTier,
  describeEverything,
  explainEverything,
  macroActionRows,
  policyCounts,
  type MacroActionRow,
  type PolicyView,
  type SetState,
} from './form-state';

const VIEWS = [
  { id: 'simple', label: 'Simple' },
  { id: 'advanced', label: 'Advanced' },
] as const;

/** The account's two views, around the policy of its set or sets (`children`). */
export function MacroActionPanel({
  connection,
  view,
  onView,
  children,
}: {
  connection: IssuanceConnection;
  view: PolicyView;
  onView: (view: PolicyView) => void;
  /** One `SetPolicy` per resource set, with what goes between them. */
  children: React.ReactNode;
}) {
  const name = `${connection.provider_label} ${connection.display_name}`;
  const base = `view-${connection.id}`;
  return (
    <div className={styles.accountBody} data-testid={`macro-actions-${connection.provider}`}>
      <TabList
        base={base}
        label={`View of the permissions of ${name}`}
        tabs={VIEWS}
        active={view}
        onSelect={onView}
      />
      <TabPanel base={base} id={view} className={styles.viewPanel}>
        {children}
      </TabPanel>
    </div>
  );
}

/** A suffix that tells the controls of two sets of one account apart; none for the first. */
export function setSuffix(setIndex: number): string {
  return setIndex > 0 ? `-set${setIndex + 1}` : '';
}

/** The policy of one resource set in the account's view: macro-actions or permissions, then its count. */
export function SetPolicy({
  connection,
  state,
  view,
  setIndex = 0,
  advanced,
  onTrustLevel,
  onEverything,
  onLeaveEverything,
}: {
  connection: IssuanceConnection;
  state: SetState;
  view: PolicyView;
  /** The set, from 0. */
  setIndex?: number;
  /** The advanced view's content: the permissions one by one. */
  advanced: React.ReactNode;
  /** Ticks a macro-action at a trust level, moves it, or (`null`) unticks it. */
  onTrustLevel: (actionId: string, trustLevel: TrustLevel | null) => void;
  /** "Everything I hold on this account". */
  onEverything: () => void;
  /** Back from "Everything I hold" to the macro-actions, none ticked. */
  onLeaveEverything: () => void;
}) {
  const suffix = setSuffix(setIndex);
  const counts = policyCounts(connection, state);
  const total = counts.free + counts.asks;
  const tier = chosenTier(connection, state);
  const everything = state.everything
    ? describeEverything(connection, explainEverything(connection, state))
    : null;
  const adjusted = state.edited && !state.everything && total > 0;

  return (
    <>
      {view === 'advanced' ? (
        advanced
      ) : everything ? (
        <div
          className={styles.everythingDescription}
          data-testid={`everything-${connection.provider}${suffix}`}
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
            <p className={styles.skipped} data-testid={`adjusted-${connection.provider}${suffix}`}>
              Adjusted in the advanced view: the list no longer matches the trust levels. Changing a
              macro-action here writes it again from the trust levels.
            </p>
          )}
          <div className={styles.macroActions}>
            {macroActionRows(connection, state).map((row) => (
              <MacroActionLine
                key={row.id}
                connection={connection}
                row={row}
                setIndex={setIndex}
                onTrustLevel={(trustLevel) => onTrustLevel(row.id, trustLevel)}
              />
            ))}
          </div>
        </>
      )}

      <div className={styles.counts} data-testid={`policy-digest-${connection.provider}${suffix}`}>
        <span>
          <strong>{total}</strong> {total === 1 ? 'permission' : 'permissions'}
        </span>
        <GateMark gate="free">{counts.free} run freely</GateMark>
        {/* Amber is for what will need the person: nothing asks, nothing is coloured. */}
        <GateMark gate={counts.asks === 0 ? 'off' : 'ask'}>
          {counts.asks} {counts.asks === 1 ? 'asks' : 'ask'} you first
        </GateMark>
        {tier !== null && (
          <span
            className={styles.tier}
            data-tier={tier}
            title="Highest tier: 1 mild, 4 irreversible"
          >
            highest tier {tier}
          </span>
        )}
        {state.everything ? null : (
          <button type="button" className={styles.countsLink} onClick={onEverything}>
            Everything I hold on this account
          </button>
        )}
      </div>
    </>
  );
}

function MacroActionLine({
  connection,
  row,
  setIndex,
  onTrustLevel,
}: {
  connection: IssuanceConnection;
  row: MacroActionRow;
  setIndex: number;
  onTrustLevel: (trustLevel: TrustLevel | null) => void;
}) {
  const ticked = row.trustLevel !== null;
  const suffix = setSuffix(setIndex);
  const where = setIndex > 0 ? `, resource set ${setIndex + 1}` : '';
  const id = `macro-${connection.id}-${row.id}${suffix}`;
  const facts: string[] = [];
  if (row.leftOut > 0)
    facts.push(`${row.leftOut} left out at ${TRUST_LEVEL_LABELS[row.shownTrustLevel]}`);
  if (row.unavailable > 0) facts.push(`${row.unavailable} not available to you here`);
  return (
    <div
      className={[styles.macroAction, ticked ? '' : styles.macroActionOff].join(' ')}
      data-testid={`macro-${connection.provider}-${row.id}${suffix}`}
    >
      <Checkbox
        id={id}
        checked={ticked}
        disabled={row.empty}
        aria-label={`${row.label} on ${connection.provider_label} ${connection.display_name}${where}`}
        onChange={(event) => onTrustLevel(event.target.checked ? DEFAULT_TRUST_LEVEL : null)}
      />
      <div className={styles.macroActionText}>
        <label htmlFor={id} className={styles.macroActionName}>
          {row.label}
        </label>
        <p className={styles.quietText}>{row.description}</p>
        {/* What a trust level yields is read once the row is ticked; an empty row says why at once. */}
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
                {` · limits ×${TRUST_LEVEL_BUDGET_FACTOR[row.shownTrustLevel]}`}
              </>
            )}
          </p>
        )}
      </div>
      <ChoiceRow
        legend={`Trust level of ${row.label} on ${connection.provider_label} ${connection.display_name}${where}`}
      >
        {TRUST_LEVELS.map((trustLevel) => (
          <ChoiceChip
            key={trustLevel}
            name={`trust-level-${connection.id}-${row.id}${suffix}`}
            value={trustLevel}
            checked={row.trustLevel === trustLevel}
            onChange={() => onTrustLevel(trustLevel)}
            label={TRUST_LEVEL_LABELS[trustLevel]}
            title={TRUST_LEVEL_HINTS[trustLevel]}
            unavailable={row.empty ? 'none you may allow here' : null}
          />
        ))}
      </ChoiceRow>
    </div>
  );
}
