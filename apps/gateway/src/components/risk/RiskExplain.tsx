/**
 * How a risk is explained, wherever one is listed: its human label, why it is
 * a risk, its six-axis vector as badges, its catalog markers, and its id as a
 * link to its entry in the provider reference.
 *
 * Built once and used by the granular editor of mission creation, the Share
 * dialog's checklist, the mission page's policy table and the provider
 * reference itself, so a risk reads the same on every page. No hook: these
 * render in server and client components alike.
 */
import type { RiskId, RiskVector } from '@vaubaan/shared';

import { Badge, type BadgeTone } from '@/components/ui';
import {
  DEPRECATED_NOTE,
  FALLBACK_NOTE,
  VECTOR_AXES,
  SEVERITY_RANKS,
  vectorBadges,
  type VectorWeight,
} from '@/server/missions/catalog-view';
import type { CatalogRisk } from '@/server/missions/model';
import { riskReferencePath } from '@/server/providers/links';

import { SeverityBadge } from './RiskBadges';
import styles from './risk.module.css';

/** The mildest value is plain, the most severe stands out; the text says which. */
const WEIGHT_TONE: Readonly<Record<VectorWeight, BadgeTone>> = {
  mildest: 'neutral',
  middle: 'warning',
  worst: 'danger',
};

/**
 * The vector as six badges, `Axis: value`. The tone follows where the value
 * sits on its scale; the badge's text carries the information, and its title
 * spells the whole scale out.
 */
export function VectorBadges({ vector }: { vector: RiskVector }) {
  return (
    <span className={styles.vector} role="list" aria-label="Risk profile">
      {vectorBadges(vector).map((badge) => (
        <span key={badge.axis} role="listitem">
          <Badge tone={WEIGHT_TONE[badge.weight]}>
            <span title={`${badge.label}, from mildest to most severe: ${badge.scale.join(' · ')}`}>
              {badge.label}: {badge.value}
            </span>
          </Badge>
        </span>
      ))}
    </span>
  );
}

/** The legend of the vector: each axis, the question it answers, its scale. */
export function VectorLegend() {
  return (
    <dl className={styles.legend}>
      {VECTOR_AXES.map(({ axis, label, question }) => (
        <div key={axis} className={styles.legendRow}>
          <dt>{label}</dt>
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
 * A risk id in the monospace family, linked to its entry in the provider
 * reference. `newTab` is for the pages that hold unsaved input (mission
 * creation, the Share dialog): the reference opens beside the form, not
 * instead of it.
 */
export function RiskIdLink({ riskId, newTab = false }: { riskId: RiskId; newTab?: boolean }) {
  const href = riskReferencePath(riskId);
  if (!href) return <span className={styles.id}>{riskId}</span>;
  return (
    <a
      href={href}
      className={`${styles.id} ${styles.ref}`}
      title="What this risk means, in the provider reference"
      {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}
    >
      {riskId}
    </a>
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
 * One explicit risk, explained: label, environment, severity and markers on
 * the first line; the reason; the vector; the id. `reason={false}` is for a
 * list that already printed the entry's reason above its environment
 * variants.
 */
export function RiskExplain({
  risk,
  newTab = false,
  reason = true,
  label = true,
  labelFor,
}: {
  risk: CatalogRisk;
  newTab?: boolean;
  reason?: boolean;
  label?: boolean;
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
    <span className={styles.explain}>
      <span className={styles.head}>
        {labelFor ? (
          <label htmlFor={labelFor} className={styles.name}>
            {name}
          </label>
        ) : (
          name
        )}
        <SeverityBadge level={risk.level} />
        <RiskMarkers fallback={risk.fallback} deprecated={risk.deprecated} />
        <RiskIdLink riskId={risk.risk_id} newTab={newTab} />
      </span>
      {reason && <span className={styles.reason}>{risk.reason}</span>}
      {reason && <RiskMarkerNotes fallback={risk.fallback} deprecated={risk.deprecated} />}
      <VectorBadges vector={risk.vector} />
    </span>
  );
}
