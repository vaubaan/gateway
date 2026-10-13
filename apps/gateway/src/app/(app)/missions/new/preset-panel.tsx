'use client';

/**
 * Preset mode of one connection (spec §4.2, §3.2): the plugin's presets as an
 * explicit choice, and — for the one picked — what it allows, what waits for
 * an approval and what it leaves out, on this connection, with the resources
 * selected and the creator's authority. The lists are the policy the mission
 * would get, not a summary of it.
 *
 * Picking a preset spreads its reading out. The screen keeps one reading
 * spread out at a time by default — the preset just picked — and shows the
 * others as their description and their counts, with a button that spreads
 * them out again: three connections stay about two viewports (spec §4.2).
 */
import type { IssuanceConnection } from '@/server/missions/model';
import { presetReferencePath, providerPath } from '@/server/providers/links';

import styles from '../missions.module.css';
import {
  explainPreset,
  presetChoiceLabel,
  presetDigest,
  type ConnectionState,
  type PresetExplanation,
} from './form-state';
import { FamilyList, lineOf, PolicyLines, SkippedList } from './policy-lines';

export function PresetPanel({
  connection,
  state,
  expanded,
  onPick,
  onExpand,
}: {
  connection: IssuanceConnection;
  state: ConnectionState;
  /** The reading of the chosen preset is spread out (lists and budgets), not only counted. */
  expanded: boolean;
  onPick: (presetId: string) => void;
  onExpand: (expanded: boolean) => void;
}) {
  const name = `${connection.provider_label} ${connection.display_name}`;
  const explanations = connection.presets.flatMap((preset): PresetExplanation[] => {
    const explanation = explainPreset(connection, state, preset.id);
    return explanation ? [explanation] : [];
  });
  const chosen = explanations.find((e) => e.preset.id === state.presetId) ?? null;

  return (
    <div className={styles.policyBody} data-testid={`preset-${connection.provider}`}>
      <fieldset className={styles.choices}>
        <legend className={styles.visuallyHidden}>Preset for {name}</legend>
        {explanations.map((explanation) => {
          const { preset } = explanation;
          const checked = preset.id === state.presetId;
          return (
            <label
              key={preset.id}
              className={[styles.choice, checked ? styles.choiceOn : ''].join(' ')}
              title={preset.description}
              data-kind="preset"
            >
              <input
                type="radio"
                name={`preset-${connection.id}`}
                value={preset.id}
                checked={checked}
                onChange={() => onPick(preset.id)}
              />
              <span className={styles.choiceText}>
                <strong>{preset.label}</strong>
                <span className={styles.choiceWidth}>{presetChoiceLabel(explanation)}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {chosen ? (
        <div className={styles.presetDetail} data-testid={`preset-detail-${connection.provider}`}>
          <p className={styles.presetDescription}>{chosen.preset.description}</p>
          <p className={styles.digest} data-testid={`preset-digest-${connection.provider}`}>
            <span>{presetDigest(chosen)}</span>
            <button
              type="button"
              className={styles.linkButton}
              aria-expanded={expanded}
              aria-controls={`preset-lists-${connection.id}`}
              onClick={() => onExpand(!expanded)}
            >
              {expanded ? 'Hide the lists' : 'Show what it allows, with quotas'}
            </button>
            <a
              href={presetReferencePath(connection.provider, chosen.preset.id)}
              target="_blank"
              rel="noreferrer"
              className={styles.refLink}
            >
              What these risks mean — {connection.provider_label} reference (new tab)
            </a>
          </p>
          {expanded && (
            <div id={`preset-lists-${connection.id}`} className={styles.presetLists}>
              <PolicyLines
                title="Allowed without asking"
                lines={chosen.auto.map(lineOf)}
                empty="Nothing: every risk of this preset waits for your approval."
                testId={`preset-allowed-${connection.provider}`}
              />
              <PolicyLines
                title="Needs your approval, action by action"
                lines={chosen.approval.map(lineOf)}
                empty="Nothing: the agent never has to ask you."
                testId={`preset-approval-${connection.provider}`}
              />
              <FamilyList
                title="Not included"
                families={chosen.leftOut}
                empty="Nothing: this preset accepts every risk you can accept here."
                testId={`preset-excluded-${connection.provider}`}
              />
              <SkippedList
                families={chosen.skipped}
                testId={`preset-skipped-${connection.provider}`}
              />
            </div>
          )}
        </div>
      ) : (
        <p className={styles.panelFoot}>
          Pick a preset to read what it allows, or switch to Custom to accept risks one by one.{' '}
          <a
            href={`${providerPath(connection.provider)}#presets`}
            target="_blank"
            rel="noreferrer"
            className={styles.refLink}
          >
            Compare the {connection.provider_label} presets
          </a>{' '}
          (opens in a new tab).
        </p>
      )}
    </div>
  );
}
