/**
 * The permissions of a service against the trust levels: first the
 * macro-actions a mission ticks, then one row per catalog entry — what it
 * allows in words, its id in mono, its macro-action, one line on why it
 * matters, its severity and tier — and one column per trust level with the gate
 * and limit that trust level writes, or "left out". The difference between two trust levels
 * is read along a row; "why?" unfolds the entry: the whole reason, the six
 * words behind the severity, what it covers, its tools, and its line at each
 * trust level.
 *
 * An entry is listed once, under the kind of its most severe variant, so its
 * anchor (`#risk-<id>`) is unique; an entry that exists once per environment
 * shows one limit per environment in a cell.
 */
import { Fragment } from 'react';

import { Callout, EnvTag, GateMark, Mono, SeverityChip, Tag, WhyCells } from '@/components/ui';
import {
  ACTIONS,
  count,
  formatNumber,
  gateWordOf,
  GATE_WORDS,
  tierWord,
  PERMISSION_KINDS,
  REFERENCE_WORDS,
  SEVERITY_LABEL,
  TERMS,
} from '@/lib/vocabulary';
import {
  DEPRECATED_NOTE,
  FALLBACK_NOTE,
  formatRate,
  noteBody,
} from '@/server/missions/catalog-view';
import {
  TRUST_LEVEL_HINTS,
  TRUST_LEVEL_LABELS,
  TRUST_TRUST_LEVELS,
} from '@/server/missions/macro-actions';
import type { CatalogRisk } from '@/server/missions/model';
import { riskReferencePath } from '@/server/providers/links';
import {
  TOKEN_ACCESS_BADGE,
  TOKEN_HANDOUT_NOTE,
  type TrustLevelCell,
  type MacroActionReference,
  type RiskReference,
  type RiskReferenceGroup,
} from '@/server/providers/reference';

import styles from '../reference.module.css';

/** The variant a row shows: the most severe one, so nothing is understated. */
function worstVariant(entry: RiskReference): CatalogRisk | undefined {
  return entry.variants.reduce<CatalogRisk | undefined>(
    (worst, risk) => (worst === undefined || risk.severity > worst.severity ? risk : worst),
    undefined,
  );
}

/** One cell: per variant, the gate and limit the trust level writes, or "left out". */
function TrustLevelCellView({ cells }: { cells: readonly TrustLevelCell[] }) {
  return cells.map(({ risk, line }) => (
    <span key={risk.risk_id} className={styles.limit}>
      {risk.env && <EnvTag env={risk.env} />}
      {line === null ? (
        <span>{REFERENCE_WORDS.leftOut}</span>
      ) : (
        <>
          {line.gate === 'approval' && <GateMark gate="ask">{REFERENCE_WORDS.asksFirst}</GateMark>}
          <span title={`${formatRate(line.rate_limit)} at most`}>{formatNumber(line.quota)}</span>
        </>
      )}
    </span>
  ));
}

export function PermissionComparison({
  macroActions,
  groups,
  expanded,
  onExpanded,
  target,
  onGo,
  filtered,
}: {
  macroActions: readonly MacroActionReference[];
  /** The catalog, already narrowed by the filters in view. */
  groups: readonly RiskReferenceGroup[];
  expanded: ReadonlySet<string>;
  onExpanded: (next: ReadonlySet<string>) => void;
  /** The anchor a link pointed at: its row or its macro-action is marked. */
  target: string | null;
  onGo: (fragment: string) => void;
  /** A filter is on: an empty list then means "nothing matches", not "no permission". */
  filtered: boolean;
}) {
  const span = TRUST_TRUST_LEVELS.length + 2;
  const ids = groups.flatMap((group) => group.entries.map((entry) => entry.base_id));
  const allOpen = ids.length > 0 && ids.every((id) => expanded.has(id));

  function toggle(id: string) {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    onExpanded(next);
  }

  if (ids.length === 0) {
    return (
      <p className={styles.empty}>
        {filtered ? REFERENCE_WORDS.noMatch : 'This service declares no permission.'}
      </p>
    );
  }

  return (
    <section aria-labelledby="comparison-title" data-testid="permission-comparison">
      <div className={styles.sectionHead}>
        <h3 id="comparison-title" className={styles.sectionTitle}>
          {REFERENCE_WORDS.comparison}
        </h3>
        <span className={styles.sectionNote}>
          {REFERENCE_WORDS.comparisonNote}{' '}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => onExpanded(allOpen ? new Set() : new Set(ids))}
          >
            {allOpen ? 'Fold every why' : 'Unfold every why'}
          </button>
        </span>
      </div>
      <h4 className={styles.sectionTitle}>{REFERENCE_WORDS.macroActions}</h4>
      <p className={styles.note}>{REFERENCE_WORDS.macroActionsNote}</p>
      <ul className={styles.macroList} data-testid="macro-action-list">
        {macroActions.map((action) => (
          <li
            key={action.id}
            id={action.anchor}
            data-testid={action.anchor}
            className={[styles.macroItem, target === action.anchor ? styles.marked : ''].join(' ')}
          >
            <strong>{action.label}</strong> — {action.description} ·{' '}
            {count(action.risk_ids.length, TERMS.risk)}
          </li>
        ))}
      </ul>
      <div className={styles.scroll}>
        <table className={styles.comparison} data-testid="trust-level-matrix">
          <caption className="vbn-sr-only">
            The permissions of the service, and the gate and limit each trust level gives each of
            them
          </caption>
          <thead>
            <tr>
              <th scope="col">{REFERENCE_WORDS.permission}</th>
              <th scope="col" className={styles.severityHead}>
                {SEVERITY_LABEL}
              </th>
              {TRUST_TRUST_LEVELS.map((trustLevel) => (
                <th
                  key={trustLevel}
                  scope="col"
                  data-testid={`trust-level-${trustLevel}`}
                  title={TRUST_LEVEL_HINTS[trustLevel]}
                  className={styles.trustLevelHead}
                >
                  <span className={styles.trustLevelName}>{TRUST_LEVEL_LABELS[trustLevel]}</span>
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.kind}>
              <tr className={styles.group}>
                <th colSpan={span} scope="rowgroup">
                  {PERMISSION_KINDS[group.kind].title}
                  <span className={styles.groupNote}> · {PERMISSION_KINDS[group.kind].hint}</span>
                </th>
              </tr>
              {group.entries.map((entry) => {
                const open = expanded.has(entry.base_id);
                const shown = worstVariant(entry);
                const detailId = `${entry.anchor}-detail`;
                return (
                  <Fragment key={entry.base_id}>
                    <tr
                      id={entry.anchor}
                      data-testid={entry.anchor}
                      data-risk={entry.base_id}
                      className={[
                        open ? styles.open : '',
                        target === entry.anchor ? styles.marked : '',
                      ].join(' ')}
                    >
                      <th scope="row" className={styles.permission}>
                        <span className={styles.permissionLabel}>{entry.label}</span>{' '}
                        <Mono quiet>{entry.base_id}</Mono>
                        {(entry.envs.length > 0 ||
                          entry.macro_action ||
                          entry.fallback ||
                          entry.deprecated ||
                          entry.token_access) && (
                          <span className={styles.tags}>
                            {entry.macro_action && (
                              <a
                                href={`#${entry.macro_action.anchor}`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  if (entry.macro_action) onGo(entry.macro_action.anchor);
                                }}
                              >
                                <Tag>{entry.macro_action.label}</Tag>
                              </a>
                            )}
                            {entry.envs.map((env) => (
                              <EnvTag key={env} env={env} />
                            ))}
                            {entry.fallback && <Tag>{REFERENCE_WORDS.anythingElse}</Tag>}
                            {entry.deprecated && <Tag>{REFERENCE_WORDS.retired}</Tag>}
                            {entry.token_access && (
                              <Tag tone={entry.token_access === 'write' ? 'bad' : 'warn'}>
                                {TOKEN_ACCESS_BADGE[entry.token_access]}
                              </Tag>
                            )}
                          </span>
                        )}
                        <span className={styles.why}>
                          {!open && <span className={styles.reason}>{entry.reason}</span>}
                          <button
                            type="button"
                            className={styles.linkButton}
                            aria-expanded={open}
                            aria-controls={detailId}
                            onClick={() => toggle(entry.base_id)}
                          >
                            {open ? ACTIONS.hideWhy : ACTIONS.why}
                            <span className="vbn-sr-only"> {entry.label}</span>
                          </button>
                        </span>
                      </th>
                      <td className={styles.severityCell}>
                        {shown && <SeverityChip level={shown.level} />}
                      </td>
                      {TRUST_TRUST_LEVELS.map((trustLevel) => (
                        <td
                          key={trustLevel}
                          className={styles.trustLevelCell}
                          data-testid={`cell-${trustLevel}-${entry.base_id}`}
                        >
                          {entry.macro_action ? (
                            <TrustLevelCellView cells={entry.at_trust_level[trustLevel]} />
                          ) : (
                            <>
                              <span aria-hidden="true">—</span>
                              <span className="vbn-sr-only">{REFERENCE_WORDS.notIncluded}</span>
                            </>
                          )}
                        </td>
                      ))}
                    </tr>
                    <tr className={styles.detailRow} hidden={!open}>
                      <td colSpan={span} id={detailId}>
                        {open && <PermissionDetail entry={entry} />}
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

function PermissionDetail({ entry }: { entry: RiskReference }) {
  const shown = worstVariant(entry);
  return (
    <div className={styles.detail}>
      <p className={styles.detailReason}>{entry.reason}</p>
      {entry.vector_varies && entry.variants.length > 1 ? (
        <ul className={styles.variants}>
          {entry.variants.map((risk) => (
            <li key={risk.risk_id}>
              <span className={styles.variantHead}>
                <EnvTag env={risk.env} /> <SeverityChip level={risk.level} />
              </span>
              <WhyCells values={risk.vector} />
            </li>
          ))}
        </ul>
      ) : (
        shown && <WhyCells values={shown.vector} />
      )}
      {entry.token_access && (
        <Callout
          tone={entry.token_access === 'write' ? 'bad' : 'warn'}
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
        <dt>Held</dt>
        <dd>
          {entry.env_scoped ? (
            <>
              once per environment, as{' '}
              {entry.variants.map((risk) => (
                <Fragment key={risk.risk_id}>
                  <Mono>{risk.risk_id}</Mono>{' '}
                </Fragment>
              ))}
              — refused on a resource of another environment, or of none.
            </>
          ) : (
            'once, whatever the environment of the resource.'
          )}
        </dd>
        <dt>Covers</dt>
        <dd>
          <ul className={styles.patterns}>
            {entry.patterns.map(({ pattern, words }) => (
              <li key={pattern}>
                <span>{words}</span> <Mono quiet>{pattern}</Mono>
              </li>
            ))}
          </ul>
        </dd>
        {entry.declared_tools.length > 0 && (
          <>
            <dt>Tools</dt>
            <dd>
              {entry.declared_tools.map((tool) => (
                <Fragment key={tool}>
                  <Mono>{tool}</Mono>{' '}
                </Fragment>
              ))}
            </dd>
          </>
        )}
        <dt>Macro-action</dt>
        <dd>
          {entry.macro_action === null ? (
            'in none: a mission holds it only when someone picks it.'
          ) : (
            <>
              {entry.macro_action.label}
              <ul className={styles.patterns}>
                {TRUST_TRUST_LEVELS.flatMap((trustLevel) =>
                  entry.at_trust_level[trustLevel].map(({ risk, tier, line }) => (
                    <li key={`${trustLevel}:${risk.risk_id}`}>
                      {TRUST_LEVEL_LABELS[trustLevel]}
                      {risk.env && (
                        <>
                          {' '}
                          <EnvTag env={risk.env} />
                        </>
                      )}{' '}
                      ({tierWord(tier)}):{' '}
                      {line === null
                        ? REFERENCE_WORDS.leftOut
                        : `${formatNumber(line.quota)} per period, ${formatRate(line.rate_limit)}, ${
                            GATE_WORDS[gateWordOf(line.gate)]
                          }`}
                    </li>
                  )),
                )}
              </ul>
            </>
          )}
        </dd>
        {entry.rate_ceiling_per_minute !== null && (
          <>
            <dt>Ceiling</dt>
            <dd>
              {formatNumber(entry.rate_ceiling_per_minute)} a minute at most, whatever a mission
              asks: a limit of the service that no mission can raise.
            </dd>
          </>
        )}
        {entry.fallback && (
          <>
            <dt>{REFERENCE_WORDS.anythingElse}</dt>
            <dd>{noteBody(FALLBACK_NOTE)}</dd>
          </>
        )}
        {entry.deprecated && (
          <>
            <dt>{REFERENCE_WORDS.retired}</dt>
            <dd>
              {noteBody(DEPRECATED_NOTE)}
              {entry.replaced_by && (
                <>
                  {' '}
                  Replaced by{' '}
                  <Mono href={riskReferencePath(entry.replaced_by) ?? undefined}>
                    {entry.replaced_by}
                  </Mono>
                  .
                </>
              )}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
