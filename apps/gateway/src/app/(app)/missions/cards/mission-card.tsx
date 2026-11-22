'use client';

/**
 * One card of a mission (spec §4.2): one account and the resources of one environment,
 * then a row per macro-action of the service — ticked or not, its trust level in four
 * segments (Careful, Trusting, Autonomous, Custom), and an (i) that shows, on hover or
 * focus, the same content as the Custom modal, read-only.
 *
 * The creation/edit screen draws it live; the mission page draws it frozen with one
 * more column, the use of the period per macro-action (`today`).
 */
import type { RiskId } from '@vaubaan/shared';

import { Button, ButtonLink, Checkbox, DocHint, EnvTag, Meter, ServiceMark } from '@/components/ui';
import type { ServiceMarkIcon } from '@/components/ui';
import { CARD_WORDS, DOC_PAGES, formatNumber, TRUST_LEVEL_HINTS } from '@/lib/vocabulary';
import {
  DEFAULT_TRUST_LEVEL,
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVELS,
  type TrustLevel,
} from '@/lib/missions/macro-actions';
import type { IssuanceAccount } from '@/lib/missions/model';
import type { RiskPlanes } from '@/lib/services/planes';

import { cardResources, type CardState } from '../new/form-state';
import {
  accountLabel,
  actionRows,
  cardDigest,
  customDraftOf,
  customView,
  gaugeOf,
  levelLabel,
  reachesAccountItself,
  resourcesLine,
  showsEnv,
  type ActionRow,
  type CardLevel,
  type LineUsage,
} from './card-model';
import { LocalDate } from '@/components/LocalDate';

import { CloseOpening } from './close-opening';
import { CustomTable } from './custom-table';
import styles from './cards.styles';

/** The use of the period, on the mission page only. */
export interface CardToday {
  /** The column head: "Today", "This week", "In total". */
  readonly header: string;
  /** "today": said in the hover of a gauge. */
  readonly period: string;
  /** Calls used this period, per risk of the card. */
  readonly used: Readonly<Record<RiskId, number>>;
  /** Where "Raise this limit" leads, per macro-action; `null` when the reader cannot. */
  readonly raiseHrefs: Readonly<Record<string, string>> | null;
  /** Per risk of the card whose gate is open for the period: until when. */
  readonly openUntil: Readonly<Record<RiskId, string>>;
  /** "Close" on an opening: the mission, for its creator; `null` for anyone else. */
  readonly closeOpenings: { readonly missionId: string } | null;
}

const LEVELS: readonly CardLevel[] = [...TRUST_LEVELS, 'custom'];

export function MissionCard({
  account,
  card,
  icon,
  planes,
  limitLabel,
  issues = [],
  readOnly = false,
  today = null,
  checked = null,
  onLevel,
  onCustom,
  onChange,
  onRemove,
}: {
  account: IssuanceAccount;
  card: CardState;
  icon: ServiceMarkIcon | null;
  planes: RiskPlanes | null;
  limitLabel: string;
  /** What stands in the way on this card, in words. */
  issues?: readonly string[];
  /** The mission page: every control is frozen. */
  readOnly?: boolean;
  today?: CardToday | null;
  /** A card with future resources on the mission page: "checked … · ↻ Check now". */
  checked?: React.ReactNode;
  onLevel?: (actionId: string, level: TrustLevel | null) => void;
  onCustom?: (actionId: string) => void;
  onChange?: () => void;
  onRemove?: () => void;
}) {
  const rows = actionRows(account, card);
  const digest = cardDigest(rows);
  const label = accountLabel(account);
  const where = card.env && showsEnv(account) ? `${label} (${card.env})` : label;
  return (
    <section
      className={styles.card}
      aria-label={where}
      data-testid={`card-${account.service}`}
      data-env={card.env ?? undefined}
    >
      <div className={styles.head}>
        <ServiceMark name={account.service_label} icon={icon} />
        <span className={styles.account}>{label}</span>
        {card.env && showsEnv(account) && <EnvTag env={card.env} />}
        <span className={styles.resources} data-testid="card-resources">
          {resourcesLine(
            account.resource_noun,
            cardResources(account, card),
            card.future,
            reachesAccountItself(account, card),
          )}
        </span>
        <span className={styles.headEnd}>
          {checked}
          {!readOnly && onChange && (
            <Button
              type="button"
              size="sm"
              aria-label={CARD_WORDS.changeResources(where)}
              onClick={onChange}
            >
              Change
            </Button>
          )}
          {!readOnly && onRemove && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={CARD_WORDS.removeCard(where)}
              onClick={onRemove}
            >
              ✕
            </Button>
          )}
        </span>
      </div>
      {issues.length > 0 && (
        <ul className={styles.issues} data-testid="card-issues">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" colSpan={2}>
              {CARD_WORDS.whatItCanDo}
            </th>
            <th scope="col">
              <span className={styles.headWithDoc}>
                {CARD_WORDS.trust}
                <DocHint to={DOC_PAGES.trustLevels} testId="doc-link-trust-levels" />
              </span>
            </th>
            {today && <th scope="col">{today.header}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ActionRowView
              key={row.id}
              account={account}
              card={card}
              row={row}
              where={where}
              planes={planes}
              limitLabel={limitLabel}
              readOnly={readOnly}
              today={today}
              onLevel={(level) => onLevel?.(row.id, level)}
              onCustom={() => onCustom?.(row.id)}
            />
          ))}
        </tbody>
      </table>
      <div className={styles.foot} data-testid="card-digest">
        {CARD_WORDS.digest(digest.total, digest.free, digest.asks)}
      </div>
    </section>
  );
}

function ActionRowView({
  account,
  card,
  row,
  where,
  planes,
  limitLabel,
  readOnly,
  today,
  onLevel,
  onCustom,
}: {
  account: IssuanceAccount;
  card: CardState;
  row: ActionRow;
  where: string;
  planes: RiskPlanes | null;
  limitLabel: string;
  readOnly: boolean;
  today: CardToday | null;
  onLevel: (level: TrustLevel | null) => void;
  onCustom: () => void;
}) {
  const ticked = row.level !== null;
  const id = `macro-${card.key}-${row.id}`;
  return (
    <tr
      className={[styles.row, ticked ? '' : styles.rowOff].join(' ')}
      data-testid={`macro-${account.service}-${row.id}`}
      data-level={row.level ?? 'off'}
    >
      <td className={styles.tick}>
        <Checkbox
          id={id}
          checked={ticked}
          disabled={readOnly || row.empty}
          aria-label={`${row.label} on ${where}`}
          onChange={(event) => onLevel(event.target.checked ? DEFAULT_TRUST_LEVEL : null)}
        />
      </td>
      <td className={styles.what}>
        <label htmlFor={id} className={styles.actionName}>
          {row.label}
        </label>
        <span className={styles.actionDescription}>{row.description}</span>
      </td>
      <td className={styles.trust}>
        <TrustControl
          legend={`Trust level of ${row.label} on ${where}`}
          name={`trust-${card.key}-${row.id}`}
          level={row.level}
          readOnly={readOnly}
          empty={row.empty}
          onLevel={onLevel}
          onCustom={onCustom}
        />
        <RowInfo account={account} card={card} row={row} planes={planes} limitLabel={limitLabel} />
      </td>
      {today && (
        <td className={styles.today}>
          <Gauge row={row} today={today} resourceSetId={card.id ?? null} />
        </td>
      )}
    </tr>
  );
}

/** Careful, Trusting, Autonomous, Custom: radios, so the row is one choice. */
function TrustControl({
  legend,
  name,
  level,
  readOnly,
  empty,
  onLevel,
  onCustom,
}: {
  legend: string;
  name: string;
  level: CardLevel | null;
  readOnly: boolean;
  empty: boolean;
  onLevel: (level: TrustLevel) => void;
  onCustom: () => void;
}) {
  const off = readOnly || empty;
  return (
    <fieldset
      className={[
        styles.segments,
        off ? styles.segmentsOff : '',
        level === null ? styles.segmentsQuiet : '',
      ].join(' ')}
    >
      <legend className="vbn-sr-only">{legend}</legend>
      {LEVELS.map((option) => (
        <label
          key={option}
          className={[styles.segment, level === option ? styles.segmentOn : ''].join(' ')}
          title={option === 'custom' ? undefined : TRUST_LEVEL_HINTS[option]}
        >
          <input
            type="radio"
            name={name}
            value={option}
            checked={level === option}
            disabled={off}
            // A click, not a change: Custom opens its modal again when it is already lit.
            onChange={() => undefined}
            onClick={() => (option === 'custom' ? onCustom() : onLevel(option))}
          />
          {levelLabel(option)}
        </label>
      ))}
    </fieldset>
  );
}

/** The (i) of a row: the Custom modal's content, read-only, on hover or focus. */
function RowInfo({
  account,
  card,
  row,
  planes,
  limitLabel,
}: {
  account: IssuanceAccount;
  card: CardState;
  row: ActionRow;
  planes: RiskPlanes | null;
  limitLabel: string;
}) {
  const view = customView(account, card, row.id, planes);
  const heading = [row.label, row.level ? levelLabel(row.level) : null, card.env]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={styles.hover}>
      <button type="button" className={styles.info} aria-label={`About ${row.label}`}>
        i
      </button>
      <div className={styles.popover} role="tooltip" data-testid={`info-${row.id}`}>
        <p className={styles.popoverTitle}>{heading}</p>
        {row.level === null ? (
          <span className={styles.popoverNote}>{CARD_WORDS.notTicked}</span>
        ) : (
          <span className={styles.popoverNote}>
            {CARD_WORDS.runsFreely} · {formatNumber(row.free)} · {CARD_WORDS.asksYouFirst} ·{' '}
            {formatNumber(row.asks)} · {CARD_WORDS.leftOut} · {formatNumber(row.leftOut.length)}
            {row.level !== 'custom' &&
              ` · ${CARD_WORDS.limitsTimes(TRUST_LEVEL_BUDGET_FACTOR[row.level])}`}
          </span>
        )}
        <CustomTable
          account={account}
          card={card}
          view={view}
          lines={customDraftOf(card, view)}
          plane={null}
          limitLabel={limitLabel}
        />
      </div>
    </span>
  );
}

/** Today's use of a macro-action: the line closest to its limit, the others on hover. */
function Gauge({
  row,
  today,
  resourceSetId,
}: {
  row: ActionRow;
  today: CardToday;
  resourceSetId: string | null;
}) {
  if (row.lines.length === 0) return <span aria-hidden="true">—</span>;
  const usages: LineUsage[] = row.lines.map(({ risk, entry }) => ({
    riskId: risk.risk_id,
    label: risk.label,
    used: today.used[risk.risk_id] ?? 0,
    quota: Number(entry.quota),
    gate: entry.gate,
  }));
  const top = gaugeOf(usages);
  if (!top) return null;
  return (
    <span className={styles.hover} data-testid={`gauge-${row.id}`}>
      <button
        type="button"
        className={styles.gaugeButton}
        aria-label={`${row.label}: ${CARD_WORDS.usageOf(row.label, today.period)}`}
      >
        <Meter used={top.used} limit={top.quota} threshold={0} />
      </button>
      <div className={styles.popover} role="tooltip">
        <p className={styles.popoverTitle}>{CARD_WORDS.usageOf(row.label, today.period)}</p>
        <ul className={styles.popoverList}>
          {usages.map((u) => (
            <li key={u.riskId} data-permission={u.riskId}>
              {u.label} · {formatNumber(u.used)} / {formatNumber(u.quota)} ·{' '}
              {u.gate === 'approval' ? CARD_WORDS.asksFirst : CARD_WORDS.runsFreely}
              {today.openUntil[u.riskId] && (
                <span data-testid={`open-until-${u.riskId}`}>
                  {' · '}
                  {CARD_WORDS.runsFreelyUntil} <LocalDate ts={today.openUntil[u.riskId]} />
                  {today.closeOpenings && resourceSetId && (
                    <>
                      {' · '}
                      <CloseOpening
                        missionId={today.closeOpenings.missionId}
                        riskId={u.riskId}
                        resourceSetId={resourceSetId}
                        label={u.label}
                      />
                    </>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
        <span className={styles.popoverNote}>{CARD_WORDS.gaugeRule}</span>
        {today.raiseHrefs?.[row.id] && (
          <span className={styles.popoverNote}>
            <ButtonLink href={today.raiseHrefs[row.id] ?? ''} size="sm">
              {CARD_WORDS.raiseLimit}
            </ButtonLink>
          </span>
        )}
      </div>
    </span>
  );
}
