'use client';

/**
 * What an agent may do on one account (spec §4.2, §3.2): the presets of the
 * service first, as one choice in a row, then what the chosen one means here.
 *
 * - A preset says beside its name how many permissions it yields on this
 *   account, with the resources selected and what the reader may allow. One
 *   that would yield **nothing** is not offered silently: it is drawn as
 *   unavailable and says why ("needs a selected resource labelled "prod":
 *   none selected").
 * - "Everything I hold on this account", the built-in preset, comes last: it
 *   writes out every permission the reader may allow here, and says how many,
 *   the most severe, the critical ones and the uncategorized writes by name.
 * - "Custom" starts from an empty list.
 * - Under the row: one sentence — what the preset allows and what it asks
 *   first — then the policy as it stands, counted (runs freely, asks first,
 *   not included), and the link that opens the permissions one by one.
 *
 * Whatever is chosen, the mission stores the explicit list, never the preset.
 */
import { ChoiceChip, ChoiceRow, GateMark } from '@/components/ui';
import { MISSION_ACTIONS } from '@/lib/vocabulary';
import { presetIdsOf } from '@/server/missions/everything-i-hold';
import type { IssuanceConnection } from '@/server/missions/model';
import { presetReferencePath, providerPath } from '@/server/providers/links';

import styles from '../missions.module.css';
import {
  describeEverything,
  describeSkipped,
  explainPreset,
  policyCounts,
  presetSkipped,
  presetUnavailable,
  presetWidth,
  type ConnectionState,
  type PresetExplanation,
} from './form-state';

/** The value of the "Custom" chip in the radio group of an account. */
export const CUSTOM_CHOICE = '__custom';

export function PresetPanel({
  connection,
  state,
  editorOpen,
  onPick,
  onCustom,
  onEditor,
}: {
  connection: IssuanceConnection;
  state: ConnectionState;
  /** The granular editor of this account is open under the panel. */
  editorOpen: boolean;
  onPick: (presetId: string) => void;
  /** "Custom, start empty". */
  onCustom: () => void;
  onEditor: (open: boolean) => void;
}) {
  const name = `${connection.provider_label} ${connection.display_name}`;
  const explanations = presetIdsOf(connection).flatMap((presetId): PresetExplanation[] => {
    const explanation = explainPreset(connection, state, presetId);
    return explanation ? [explanation] : [];
  });
  const chosen = explanations.find((e) => e.preset.id === state.presetId) ?? null;
  const adjusted = state.mode === 'custom' && state.edited;
  const custom = state.mode === 'custom' && state.presetId === '';
  const counts = policyCounts(connection, state);
  const total = counts.free + counts.asks;
  // What the untouched preset could not bring here: said, never dropped silently.
  const skipped = chosen && !adjusted ? describeSkipped(presetSkipped(connection, state)) : null;
  const everything = chosen ? describeEverything(connection, chosen) : null;

  return (
    <div className={styles.accountBody} data-testid={`preset-${connection.provider}`}>
      <ChoiceRow legend={`Preset for ${name}`}>
        {explanations.map((explanation) => {
          const { preset } = explanation;
          const checked = preset.id === state.presetId;
          return (
            <ChoiceChip
              key={preset.id}
              name={`preset-${connection.id}`}
              value={preset.id}
              checked={checked}
              onChange={onPick}
              label={preset.label}
              hint={checked && adjusted ? `${total} · adjusted` : String(presetWidth(explanation))}
              // The chosen one stays a choice even if it yields nothing now: it must be undoable.
              unavailable={checked ? null : presetUnavailable(explanation)}
              title={preset.description}
            />
          );
        })}
        <ChoiceChip
          name={`preset-${connection.id}`}
          value={CUSTOM_CHOICE}
          checked={custom}
          onChange={onCustom}
          label="Custom"
          hint={custom ? `${total} chosen` : 'start empty'}
        />
      </ChoiceRow>

      {chosen && everything ? (
        <div
          className={styles.presetDescription}
          data-testid={`preset-detail-${connection.provider}`}
        >
          {everything.map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
        </div>
      ) : chosen ? (
        <p
          className={styles.presetDescription}
          data-testid={`preset-detail-${connection.provider}`}
        >
          {chosen.preset.description}{' '}
          <a
            href={presetReferencePath(connection.provider, chosen.preset.id)}
            target="_blank"
            rel="noreferrer"
            className={styles.link}
          >
            In the reference (new tab)
          </a>
        </p>
      ) : custom ? (
        <p className={styles.presetDescription} data-testid={`custom-${connection.provider}`}>
          Your own list: nothing here comes from a preset. It is the explicit list this mission
          would carry.
        </p>
      ) : (
        <p className={styles.presetDescription}>
          Pick a preset to read what it allows, or Custom to choose the permissions one by one.{' '}
          <a
            href={`${providerPath(connection.provider)}#presets`}
            target="_blank"
            rel="noreferrer"
            className={styles.link}
          >
            Compare the presets (new tab)
          </a>
        </p>
      )}

      {(chosen || custom) && (
        <div className={styles.counts} data-testid={`preset-digest-${connection.provider}`}>
          <GateMark gate="free">{counts.free} run freely</GateMark>
          {/* Amber is for what will need the person: nothing asks, nothing is coloured. */}
          <GateMark gate={counts.asks === 0 ? 'off' : 'ask'}>
            {counts.asks} {counts.asks === 1 ? 'asks' : 'ask'} you first
          </GateMark>
          <GateMark gate="off">{counts.notIncluded} not included</GateMark>
          <button
            type="button"
            className={styles.countsLink}
            aria-expanded={editorOpen}
            aria-controls={`editor-${connection.id}`}
            onClick={() => onEditor(!editorOpen)}
          >
            {editorOpen ? MISSION_ACTIONS.hideEditor : MISSION_ACTIONS.editOneByOne}
          </button>
        </div>
      )}
      {skipped && (
        <p className={styles.skipped} data-testid={`preset-skipped-${connection.provider}`}>
          {skipped}
        </p>
      )}
      {chosen && !adjusted && total === 0 && (
        <p
          className={styles.skipped}
          role="status"
          data-testid={`preset-empty-${connection.provider}`}
        >
          This preset allows nothing here: {presetUnavailable(chosen) ?? 'it holds no permission'}.
          Pick another preset, change the resources, or leave this account out.
        </p>
      )}
    </div>
  );
}
