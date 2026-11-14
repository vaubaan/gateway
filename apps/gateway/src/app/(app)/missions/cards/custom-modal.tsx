'use client';

/**
 * "Custom" on a macro-action of a card (spec §4.2): its permissions one by one. "Start
 * from" a trust level writes its lines, then single lines change; the plane chips only
 * filter the list (the mission stores permissions, never planes). Apply hands the lines
 * back; the card reads Custom unless they fall exactly on a level.
 */
import { useState } from 'react';
import type { RiskId } from '@vaubaan/shared';

import { Button, Dialog, EnvTag, FilterChips } from '@/components/ui';
import { ACTIONS, CARD_WORDS, TRUST_LEVEL_LABELS } from '@/lib/vocabulary';
import { DEFAULT_TRUST_LEVEL, TRUST_LEVELS, type TrustLevel } from '@/lib/missions/macro-actions';
import type { IssuanceAccount } from '@/lib/missions/model';
import type { RiskPlanes } from '@/lib/providers/planes';

import type { CardState, EntryState } from '../new/form-state';
import { accountLabel, customDraftOf, customView, startFrom } from './card-model';
import { CustomTable } from './custom-table';
import styles from './cards.module.css';

/** The chip that shows every plane. */
const ALL = 'all';

export function PlaneChips({
  view,
  plane,
  onPlane,
  label,
}: {
  view: ReturnType<typeof customView>;
  plane: string | null;
  onPlane: (plane: string | null) => void;
  label: string;
}) {
  if (view.planes.length < 2) return null;
  const total = view.rows.length + view.never.length;
  return (
    <FilterChips
      label={label}
      options={[
        { value: ALL, label: CARD_WORDS.allPlanes, count: total },
        ...view.planes.map((p) => ({ value: p.slug, label: p.slug, count: p.count })),
      ]}
      selected={[plane ?? ALL]}
      onToggle={(value) => onPlane(value === ALL ? null : value)}
    />
  );
}

export function CustomModal({
  account,
  card,
  actionId,
  planes,
  limitLabel,
  onCancel,
  onApply,
}: {
  account: IssuanceAccount;
  card: CardState;
  actionId: string;
  planes: RiskPlanes | null;
  limitLabel: string;
  onCancel: () => void;
  onApply: (lines: Readonly<Record<RiskId, EntryState | null>>, startFrom: TrustLevel) => void;
}) {
  const action = account.macro_actions.find((a) => a.id === actionId);
  const view = customView(account, card, actionId, planes);
  const [lines, setLines] = useState(() => customDraftOf(card, view));
  const [start, setStart] = useState<TrustLevel>(
    () => card.trustLevels[actionId] ?? DEFAULT_TRUST_LEVEL,
  );
  const [plane, setPlane] = useState<string | null>(null);
  if (!action) return null;
  const name = `${action.label} · ${accountLabel(account)}`;
  return (
    <Dialog
      open
      onClose={onCancel}
      width="lg"
      divided
      testId="custom-modal"
      title={
        <>
          {name}
          {card.env && (
            <>
              {' '}
              <EnvTag env={card.env} />
            </>
          )}
        </>
      }
      footer={
        <>
          <Button type="button" variant="primary" onClick={() => onApply(lines, start)}>
            {CARD_WORDS.apply}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {ACTIONS.cancel}
          </Button>
        </>
      }
    >
      <div className={styles.tools}>
        <span>{CARD_WORDS.startFrom}</span>
        <fieldset className={styles.segments}>
          <legend className="vbn-sr-only">{`${CARD_WORDS.startFrom}: ${name}`}</legend>
          {TRUST_LEVELS.map((level) => (
            <label
              key={level}
              className={[styles.segment, start === level ? styles.segmentOn : ''].join(' ')}
            >
              <input
                type="radio"
                name={`start-${card.key}-${actionId}`}
                value={level}
                checked={start === level}
                onChange={() => {
                  setStart(level);
                  setLines(startFrom(account, card, actionId, view, level));
                }}
              />
              {TRUST_LEVEL_LABELS[level]}
            </label>
          ))}
        </fieldset>
        <span>{CARD_WORDS.thenSingleLines}</span>
      </div>
      <div className={styles.tools}>
        <PlaneChips view={view} plane={plane} onPlane={setPlane} label={`Planes of ${name}`} />
      </div>
      <CustomTable
        account={account}
        card={card}
        view={view}
        lines={lines}
        plane={plane}
        limitLabel={limitLabel}
        onLine={(riskId, entry) => setLines((current) => ({ ...current, [riskId]: entry }))}
      />
      {view.planes.length > 1 && <p className={styles.planeNote}>{CARD_WORDS.planesOnlyFilter}</p>}
    </Dialog>
  );
}
