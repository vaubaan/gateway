/**
 * The risk catalog as a grouped list of compact rows: reads, writes,
 * irreversible writes. A row is the label, the id, one line of reason, the
 * six-cell vector strip, the environments and the presets that include it;
 * the patterns, the per-environment profiles and the notes are behind the
 * row's own disclosure.
 */
import { SeverityBadge } from '@/components/risk/RiskBadges';
import { RiskMarkers, VectorStrip } from '@/components/risk/RiskExplain';
import { Badge, Callout, Glyph, Slug } from '@/components/ui';
import { DEPRECATED_NOTE, FALLBACK_NOTE, noteBody } from '@/server/missions/catalog-view';
import type { CatalogRisk } from '@/server/missions/model';
import { riskReferencePath } from '@/server/providers/links';
import {
  TOKEN_ACCESS_BADGE,
  TOKEN_HANDOUT_NOTE,
  type RiskReference,
  type RiskReferenceGroup,
} from '@/server/providers/reference';

import styles from '../reference.module.css';

/** The variant the collapsed row shows: the most severe one, so nothing is understated. */
function worstVariant(entry: RiskReference): CatalogRisk | undefined {
  return entry.variants.reduce<CatalogRisk | undefined>(
    (worst, risk) => (worst === undefined || risk.severity > worst.severity ? risk : worst),
    undefined,
  );
}

export function RiskList({
  groups,
  expanded,
  onExpanded,
  target,
  onGo,
}: {
  /** The catalog, already limited to the plane in view. */
  groups: readonly RiskReferenceGroup[];
  expanded: ReadonlySet<string>;
  onExpanded: (next: ReadonlySet<string>) => void;
  target: string | null;
  onGo: (fragment: string) => void;
}) {
  const ids = groups.flatMap((group) => group.entries.map((entry) => entry.base_id));
  const allOpen = ids.length > 0 && ids.every((id) => expanded.has(id));

  function toggle(id: string) {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    onExpanded(next);
  }

  if (ids.length === 0) return <p className={styles.empty}>No risk on this plane.</p>;

  return (
    <div className={styles.section}>
      <p className={styles.sectionLine}>
        An entry is touched when a call matches one of its patterns; a call may touch several, and a
        mission must accept all of them.{' '}
        <button
          type="button"
          className={styles.textButton}
          onClick={() => onExpanded(allOpen ? new Set() : new Set(ids))}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </p>
      {groups.map((group) => (
        <section key={group.kind} aria-label={group.title} className={styles.group}>
          <h2 className={styles.groupTitle}>
            <span>
              {group.title} <span className={styles.groupCount}>{group.entries.length}</span>
            </span>
            <span className={styles.groupHint}>{group.hint}</span>
          </h2>
          <div className={styles.rows} data-kind="risk">
            {group.entries.map((entry) => (
              <RiskRow
                key={entry.base_id}
                entry={entry}
                open={expanded.has(entry.base_id)}
                marked={target === entry.anchor}
                onToggle={() => toggle(entry.base_id)}
                onGo={onGo}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function RiskRow({
  entry,
  open,
  marked,
  onToggle,
  onGo,
}: {
  entry: RiskReference;
  open: boolean;
  marked: boolean;
  onToggle: () => void;
  onGo: (fragment: string) => void;
}) {
  const shown = worstVariant(entry);
  const detailId = `${entry.anchor}-detail`;
  const link = (fragment: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    onGo(fragment);
  };
  return (
    <article
      id={entry.anchor}
      data-testid={entry.anchor}
      className={[styles.risk, marked ? styles.riskTarget : ''].join(' ')}
    >
      <div className={styles.riskHead}>
        <h3 className={styles.riskTitle}>
          <button
            type="button"
            className={styles.riskToggle}
            aria-expanded={open}
            aria-controls={detailId}
            onClick={onToggle}
          >
            <Glyph name="chevron" className={styles.chevron} />
            <span>{entry.label}</span>
          </button>
          {shown && <SeverityBadge level={shown.level} />}
          <RiskMarkers fallback={entry.fallback} deprecated={entry.deprecated} />
          {entry.token_access && (
            <Badge tone={entry.token_access === 'write' ? 'danger' : 'warning'}>
              <span title={TOKEN_HANDOUT_NOTE}>{TOKEN_ACCESS_BADGE[entry.token_access]}</span>
            </Badge>
          )}
        </h3>
        <div className={styles.riskStrip}>
          {shown && <VectorStrip vector={shown.vector} focusable />}
        </div>
        <div className={styles.riskLine}>
          <p className={styles.riskSub}>
            <Slug
              kind="risk"
              href={`#${entry.anchor}`}
              onClick={link(entry.anchor)}
              title="Risk id — link to this entry"
            >
              {entry.base_id}
            </Slug>
            {!open && <span className={styles.riskReason}>{entry.reason}</span>}
          </p>
          <p className={styles.riskTags}>
            {entry.envs.length > 0 && (
              <span className={styles.tagGroup}>
                {entry.envs.map((env) => (
                  <Badge key={env} mono>
                    <span title="Accepted separately in this environment">{env}</span>
                  </Badge>
                ))}
                {entry.vector_varies && <span className={styles.tagCaption}>worst shown</span>}
              </span>
            )}
            <span className={styles.tagGroup}>
              {entry.presets.length === 0 ? (
                <span className={styles.tagCaption}>in no preset</span>
              ) : (
                entry.presets.map((preset) => (
                  <Slug
                    key={preset.id}
                    kind="preset"
                    mono={false}
                    href={`#${preset.anchor}`}
                    onClick={link(preset.anchor)}
                    title={`Included in the preset ${preset.label}`}
                  >
                    {preset.label}
                  </Slug>
                ))
              )}
            </span>
          </p>
        </div>
      </div>
      <div id={detailId} className={styles.riskDetail} hidden={!open}>
        {open && <RiskDetail entry={entry} />}
      </div>
    </article>
  );
}

function RiskDetail({ entry }: { entry: RiskReference }) {
  return (
    <>
      <p className={styles.detailReason}>{entry.reason}</p>
      {entry.fallback && (
        <Callout tone="warning" title="Fallback entry">
          {noteBody(FALLBACK_NOTE)}
        </Callout>
      )}
      {entry.deprecated && (
        <Callout tone="neutral" icon="archive" title="Deprecated">
          {noteBody(DEPRECATED_NOTE)}
          {entry.replaced_by && (
            <>
              {' '}
              Replaced by{' '}
              <Slug kind="risk" href={riskReferencePath(entry.replaced_by)}>
                {entry.replaced_by}
              </Slug>
              .
            </>
          )}
        </Callout>
      )}
      {entry.token_access && (
        <Callout
          tone={entry.token_access === 'write' ? 'danger' : 'warning'}
          icon="key"
          title={
            entry.token_access === 'write'
              ? 'Hands the agent a token that can write'
              : 'Hands the agent a read-only token'
          }
        >
          {noteBody(TOKEN_HANDOUT_NOTE)}
        </Callout>
      )}
      <dl className={styles.detailFacts}>
        <dt>Scope</dt>
        <dd>
          {entry.env_scoped ? (
            <>
              Environment-scoped — accepted separately as{' '}
              {entry.variants.map((risk) => (
                <Slug key={risk.risk_id} kind="risk" className={styles.inlineSlug}>
                  {risk.risk_id}
                </Slug>
              ))}
              . Refused on a resource of any other environment, or with no environment.
            </>
          ) : (
            'Account-scoped — accepted once, whatever the environment of the resource.'
          )}
        </dd>
        {entry.vector_varies && entry.variants.length > 1 && (
          <>
            <dt>Profiles</dt>
            <dd>
              <ul className={styles.variants}>
                {entry.variants.map((risk) => (
                  <li key={risk.risk_id}>
                    <span className={styles.variantHead}>
                      <Badge mono>{risk.env ?? 'account'}</Badge>
                      <SeverityBadge level={risk.level} />
                    </span>
                    <VectorStrip vector={risk.vector} />
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>Matches</dt>
        <dd>
          <ul className={styles.patterns}>
            {entry.patterns.map(({ pattern, words }) => (
              <li key={pattern}>
                <span>{words}</span>
                <code className={styles.pattern}>{pattern}</code>
              </li>
            ))}
          </ul>
        </dd>
        {entry.declared_tools.length > 0 && (
          <>
            <dt>Tools</dt>
            <dd>
              {entry.declared_tools.map((tool) => (
                <Slug key={tool} kind="tool" className={styles.inlineSlug}>
                  {tool}
                </Slug>
              ))}
            </dd>
          </>
        )}
        {entry.rate_ceiling_per_minute !== null && (
          <>
            <dt>Ceiling</dt>
            <dd>
              At most {entry.rate_ceiling_per_minute} actions per minute, whatever a mission asks: a
              limit of the plugin that no mission can raise.
            </dd>
          </>
        )}
      </dl>
    </>
  );
}
