/**
 * The marks of a service's page (website spec §2.3), styled in
 * `plugin-page.css`:
 *
 * - `Mono` — an identifier as the protocol spells it, wrapping between words.
 * - `Gate` — what a trust level does, in one short word (yes, ask me, no),
 *   coloured; the map's legend gives the gateway's words beside each.
 * - `RowGlyph` — the glyph of a row of the tree, beside its name.
 * - `Info` — an (i) that shows a declared text on hover or focus; the text is
 *   in the DOM, so a reader without the tooltip still reads it.
 * - `ServiceMark` — the plugin's brand icon in its colour; a near-black brand
 *   takes the ink in the dark theme (`serviceMarkColors`, the gateway's rule).
 *
 * Imports are relative: the unit tests render these without an app's alias.
 */
import { Fragment, type CSSProperties } from 'react';

import type { GateWord, Row } from '@vaubaan/policy-engine';
import { serviceMarkColors } from '@vaubaan/shared/service-mark';

import { GATE_SHORT } from './page-data';

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

export function Gate({ gate }: { gate: GateWord }) {
  return (
    <b className={`pp-g g-${gate}`} data-gate={gate}>
      {GATE_SHORT[gate]}
    </b>
  );
}

/** One glyph per row, worst first: no entry, a warning, an eye, an undo arrow. */
const GLYPHS: Readonly<Record<Row, readonly string[]>> = {
  4: ['M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2z', 'M3.8 3.8l8.4 8.4'],
  3: ['M8 2.2L14.2 13.3H1.8z', 'M8 6.5v3.2M8 11.4v.4'],
  2: [
    'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z',
    'M8 6a2 2 0 1 0 0 4A2 2 0 1 0 8 6z',
  ],
  1: ['M3.5 6.5h6.5a3.5 3.5 0 0 1 0 7H6', 'M6.5 3.5l-3 3 3 3'],
};

export function RowGlyph({ row }: { row: Row }) {
  return (
    <svg className="pp-gl" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {GLYPHS[row].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** A declared text behind an (i): the catalog's reason, an entity's description. */
export function Info({ label, text, code }: { label: string; text: string; code?: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <span className="pp-info" tabIndex={0}>
      <svg className="pp-ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13A6.5 6.5 0 1 0 8 1.5z" />
        <path d="M8 7.3v4" />
        <path d="M8 4.8v.2" />
      </svg>
      <span className="sr">{label}: </span>
      <span className="pp-tip" role="tooltip">
        {parts.map((part, i) =>
          part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
            <code key={i}>{part.slice(1, -1)}</code>
          ) : (
            <Fragment key={i}>{part}</Fragment>
          ),
        )}
        {code && (
          <>
            {' '}
            <code>{code}</code>
          </>
        )}
      </span>
    </span>
  );
}

/**
 * The service's mark: the plugin's path in its brand colour, through
 * `--mark-color` and `--mark-color-dark` (`plugin-page.css` picks one by the
 * reader's theme). `size="sm"` beside a name in a list, the default in a
 * page's header.
 */
export function ServiceMark({
  path,
  color,
  size = 'lg',
}: {
  path: string;
  color: string | null;
  size?: 'sm' | 'lg';
}) {
  const { light, dark } = serviceMarkColors(color);
  const style = light
    ? ({ '--mark-color': light, '--mark-color-dark': dark ?? 'var(--ink)' } as CSSProperties)
    : undefined;
  const px = size === 'sm' ? 16 : 32;
  return (
    <span
      className={size === 'sm' ? 'pp-svc pp-svc-sm' : 'pp-svc'}
      style={style}
      aria-hidden="true"
    >
      <svg width={px} height={px} viewBox="0 0 24 24" focusable="false">
        <path fill="currentColor" d={path} />
      </svg>
    </span>
  );
}
