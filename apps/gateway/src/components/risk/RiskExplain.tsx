/**
 * How a risk is explained, wherever one is listed: its human label, its id as
 * a risk-coloured slug linked to its entry in the provider reference, one line
 * of reason that unfolds, its six-axis vector as a compact strip, and its
 * catalog markers.
 *
 * Built once and used by the Custom editor of mission creation, the Share
 * dialog's checklist, the mission page's policy table and the provider
 * reference itself, so a risk reads the same on every page. No hook: these
 * render in server and client components alike.
 */
import type { RiskId, RiskVector } from '@vaubaan/shared';

import { Badge, Slug } from '@/components/ui';
import {
  DEPRECATED_NOTE,
  FALLBACK_NOTE,
  VECTOR_AXES,
  SEVERITY_RANKS,
  vectorBadges,
  type VectorWeight,
} from '@/server/missions/catalog-view';
import type { CatalogRisk, RiskKind } from '@/server/missions/model';
import { riskReferencePath } from '@/server/providers/links';

import { SeverityBadge } from './RiskBadges';
import styles from './risk.module.css';

/** A cell is plain when its value is the mildest of its axis, and stands out above it. */
const WEIGHT_CLASS: Readonly<Record<VectorWeight, string>> = {
  mildest: styles.cellMild ?? '',
  middle: styles.cellMiddle ?? '',
  worst: styles.cellWorst ?? '',
};

/**
 * The vector as a strip of six cells: the axis in a few letters over its
 * value. A cell is neutral at the mildest value and takes a status tone above
 * it; the value is always written, and the strip spells every axis out in
 * full on hover, on focus and to assistive technology.
 */
export function VectorStrip({
  vector,
  focusable = false,
}: {
  vector: RiskVector;
  /** Reachable by Tab, so that a keyboard user gets the full names too. */
  focusable?: boolean;
}) {
  const badges = vectorBadges(vector);
  const full = badges.map((badge) => `${badge.label}: ${badge.value}`).join(' · ');
  return (
    <span
      className={styles.strip}
      role="list"
      aria-label="Risk profile"
      data-full={full}
      tabIndex={focusable ? 0 : undefined}
    >
      {badges.map((badge) => (
        <span
          key={badge.axis}
          role="listitem"
          className={[styles.cell, WEIGHT_CLASS[badge.weight]].join(' ')}
          aria-label={`${badge.label}: ${badge.value}`}
          title={`${badge.label}: ${badge.value} (from mildest to most severe: ${badge.scale.join(' · ')})`}
        >
          <span className={styles.axis} aria-hidden="true">
            {badge.abbr}
          </span>
          <span className={styles.value} aria-hidden="true">
            {badge.value}
          </span>
        </span>
      ))}
    </span>
  );
}

/** The legend of the vector: each axis, its short name, the question it answers, its scale. */
export function VectorLegend() {
  return (
    <dl className={styles.legend}>
      {VECTOR_AXES.map(({ axis, label, abbr, question }) => (
        <div key={axis} className={styles.legendRow}>
          <dt>
            <span className={styles.axis}>{abbr}</span> {label}
          </dt>
          <dd>
            {question}{' '}
            <span className={styles.scale}>
              {SEVERITY_RANKS[axis].map((value, index) => (
                <span key={value}>
                  {index > 0 && ' → '}
                  {value}
                </span>
              ))}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A risk id as a risk-coloured slug, linked to its entry in the provider
 * reference. `newTab` is for the pages that hold unsaved input (mission
 * creation, the Share dialog): the reference opens beside the form, not
 * instead of it.
 */
export function RiskIdLink({ riskId, newTab = false }: { riskId: RiskId; newTab?: boolean }) {
  return (
    <Slug
      kind="risk"
      href={riskReferencePath(riskId)}
      newTab={newTab}
      title="Risk — what it means, in the provider reference"
    >
      {riskId}
    </Slug>
  );
}

/** How the three classes of risk read on a row; the word says it, the tone only helps. */
const KIND_WORDS: Readonly<Record<RiskKind, string>> = {
  read: 'read',
  write: 'write',
  destructive: 'irreversible',
};

/** Read, write or irreversible: the class of a risk, where a list is not grouped by it. */
export function RiskClassTag({ kind }: { kind: RiskKind }) {
  return (
    <span className={[styles.classTag, styles[`class_${kind}`]].join(' ')}>{KIND_WORDS[kind]}</span>
  );
}

/** The catalog markers of an entry, each with the sentence that explains it. */
export function RiskMarkers({ fallback, deprecated }: { fallback: boolean; deprecated: boolean }) {
  return (
    <>
      {fallback && (
        <Badge tone="warning">
          <span title={FALLBACK_NOTE}>fallback</span>
        </Badge>
      )}
      {deprecated && (
        <Badge tone="warning">
          <span title={DEPRECATED_NOTE}>deprecated</span>
        </Badge>
      )}
    </>
  );
}

/** The sentences behind the markers, for the pages that have room to state them. */
export function RiskMarkerNotes({
  fallback,
  deprecated,
}: {
  fallback: boolean;
  deprecated: boolean;
}) {
  if (!fallback && !deprecated) return null;
  return (
    <span className={styles.note}>
      {fallback && FALLBACK_NOTE}
      {fallback && deprecated && ' '}
      {deprecated && DEPRECATED_NOTE}
    </span>
  );
}

/**
 * Why it is a risk, on one line that unfolds in place: a native disclosure,
 * so it needs no script and is a button to the keyboard.
 */
export function RiskReason({ children }: { children: React.ReactNode }) {
  return (
    <details className={styles.why}>
      <summary title="Show the whole reason">{children}</summary>
    </details>
  );
}

/**
 * One explicit risk, explained in a compact row: label, environment, class,
 * severity and markers on the first line; the id and one line of reason that
 * unfolds on the second; the vector strip. `reason={false}` is for a list that already
 * printed the entry's reason above its environment variants.
 */
export function RiskExplain({
  risk,
  newTab = false,
  reason = true,
  label = true,
  kindTag = true,
  labelFor,
}: {
  risk: CatalogRisk;
  newTab?: boolean;
  reason?: boolean;
  label?: boolean;
  /** `false` in a list already grouped into reads, writes and irreversible writes. */
  kindTag?: boolean;
  /** `id` of the checkbox this explanation labels: the name becomes its `<label>`. */
  labelFor?: string;
}) {
  const name = (
    <>
      {label && <span className={styles.label}>{risk.label}</span>}
      {risk.env && (
        <Badge mono>
          <span title="Environment this id is accepted in">{risk.env}</span>
        </Badge>
      )}
    </>
  );
  return (
    <div className={styles.explain}>
      <div className={styles.head}>
        {labelFor ? (
          <label htmlFor={labelFor} className={styles.name}>
            {name}
          </label>
        ) : (
          name
        )}
        {kindTag && <RiskClassTag kind={risk.kind} />}
        <SeverityBadge level={risk.level} />
        <RiskMarkers fallback={risk.fallback} deprecated={risk.deprecated} />
      </div>
      <div className={styles.sub}>
        <RiskIdLink riskId={risk.risk_id} newTab={newTab} />
        {reason && (
          <RiskReason>
            {risk.reason}
            {(risk.fallback || risk.deprecated) && (
              <>
                {' '}
                <RiskMarkerNotes fallback={risk.fallback} deprecated={risk.deprecated} />
              </>
            )}
          </RiskReason>
        )}
      </div>
      <VectorStrip vector={risk.vector} />
    </div>
  );
}
