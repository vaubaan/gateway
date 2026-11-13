/**
 * The display codes of the gateway (style guide §5), mirrored for the site:
 * the same words, the same marks, the same colour rule — a status is
 * coloured only when it differs from normal. The words come from
 * `@vaubaan/policy-engine`; the look is `globals.css` ("Display codes").
 *
 * - `RiskWord` — the row word of a permission; harmless is plain, rows 2 and above tinted.
 * - `GateMark` — runs freely, ask me first, not included: a dot and the words.
 * - `FactCells` — the five facts in words, the one that moved the gate tinted.
 * - `Tag` — a fact that is not a state (an environment), squared.
 * - `Mono` — an identifier as the protocol spells it, wrapping between words.
 * - `PermissionBox` — a permission on the map, tinted by its row.
 *
 * Imports are relative: the unit tests render these without the `@/` alias.
 */
import { Fragment, type ReactNode } from 'react';

import { GATE_WORDS, REASON_WORDS, ROW_WORDS, type GateWord } from '@vaubaan/policy-engine';

import type { PermissionBox as Box } from '../../content/plugin-page';
import type { FactInfo, Row } from '../../content/plugins';

/** `a_b.c-d/e` → where an identifier may wrap: after each separator. */
const WORD_END = /(?<=[_.\-/:\]@])(?=[^_.\-/:\]@])/;

export function Mono({ children, quiet = false }: { children: string; quiet?: boolean }) {
  const words = children.split(WORD_END);
  return (
    <code className={quiet ? 'id quiet' : 'id'}>
      {words.map((word, index) => (
        // The words of one id, in order: the index is their identity.
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {word}
        </Fragment>
      ))}
    </code>
  );
}

export function RiskWord({ row }: { row: Row }) {
  return (
    <span className={`risk risk-row-${row}`} data-row={row}>
      {ROW_WORDS[row]}
    </span>
  );
}

export function GateMark({ gate, children }: { gate: GateWord; children?: ReactNode }) {
  return (
    <span className={`gate gate-${gate}`} data-gate={gate}>
      {children ?? GATE_WORDS[gate]}
    </span>
  );
}

export function FactCells({ facts }: { facts: readonly FactInfo[] }) {
  return (
    <dl className="cells">
      {facts.map((fact) => (
        <div
          key={fact.axis}
          className={fact.movesGate ? 'cell cell-moves' : 'cell'}
          data-moves-gate={fact.movesGate || undefined}
        >
          <dt>{fact.label}</dt>
          <dd>{fact.word}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

export function PermissionBox({ box }: { box: Box }) {
  const classes = ['perm', `perm-row-${box.row}`, box.fallback ? 'perm-fallback' : '']
    .filter(Boolean)
    .join(' ');
  const why = box.rowReason ? ` · ${REASON_WORDS[box.rowReason]}` : '';
  return (
    <li className={classes} data-risk-id={box.riskId} title={`${box.riskId}${why}`}>
      <span>{box.label}</span>
      {box.envs.map((env) => (
        <Tag key={env}>{env}</Tag>
      ))}
    </li>
  );
}
