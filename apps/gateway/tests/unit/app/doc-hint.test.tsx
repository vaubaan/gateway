/**
 * The doc hint (docs/handbook/web-app.md, "doc hints"): what keeps it open,
 * where it is placed, and what it draws without a browser. Hover, focus and
 * the click that opens no page are checked in a browser by
 * `tests/e2e/shell.spec.ts`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  DocHint,
  DocsProvider,
  HINT_CLOSED,
  HINT_GAP,
  HINT_MARGIN,
  hintOpen,
  hintReducer,
  placeHint,
  type HintEvent,
  type HintState,
} from '@/components/ui/DocHint';
import { DOC_PAGES } from '@/lib/vocabulary';

function after(...events: HintEvent[]): HintState {
  return events.reduce(hintReducer, HINT_CLOSED);
}

describe('doc hint: what keeps it open', () => {
  it('opens on hover and on focus, and closes when both are gone', () => {
    expect(hintOpen(after('pointer-in'))).toBe(true);
    expect(hintOpen(after('focus-in'))).toBe(true);
    expect(hintOpen(after('pointer-in', 'pointer-out'))).toBe(false);
    expect(hintOpen(after('focus-in', 'focus-out'))).toBe(false);
    // The focus keeps it open while the pointer leaves, and the other way round.
    expect(hintOpen(after('focus-in', 'pointer-in', 'pointer-out'))).toBe(true);
    expect(hintOpen(after('pointer-in', 'focus-in', 'focus-out'))).toBe(true);
  });

  it('a click pins it open; a second click closes it', () => {
    const pinned = after('toggle');
    expect(pinned.pinned).toBe(true);
    expect(hintOpen(after('toggle', 'pointer-out', 'focus-out'))).toBe(true);
    expect(hintOpen(after('toggle', 'toggle'))).toBe(false);
    // A click on a hint the pointer opened pins it rather than closing it.
    expect(after('pointer-in', 'toggle').pinned).toBe(true);
    // A tap focuses, then clicks: it stays, pinned.
    expect(after('focus-in', 'toggle')).toEqual({ hovered: false, focused: true, pinned: true });
    expect(hintOpen(after('pointer-in', 'toggle', 'toggle'))).toBe(false);
  });

  it('Escape and a press outside close it, pinned or not', () => {
    for (const close of ['escape', 'outside'] as const) {
      expect(after('toggle', close)).toEqual(HINT_CLOSED);
      expect(after('pointer-in', 'focus-in', close)).toEqual(HINT_CLOSED);
    }
  });
});

describe('doc hint: placed inside the viewport', () => {
  const desk = { width: 1280, height: 800 };
  const size = { width: 320, height: 120 };
  const at = (left: number, top: number) => ({ left, top, width: 20, height: 20 });

  it('below the (i), from its left edge, when there is room', () => {
    expect(placeHint(at(300, 100), size, desk)).toEqual({
      left: 300,
      top: 100 + 20 + HINT_GAP,
      above: false,
    });
  });

  it('flips to end at the (i)’s right edge near the right edge', () => {
    expect(placeHint(at(1200, 100), size, desk).left).toBe(1200 + 20 - 320);
  });

  it('flips above near the bottom when there is more room there', () => {
    const spot = placeHint(at(300, 760), size, desk);
    expect(spot.above).toBe(true);
    expect(spot.top).toBe(760 - HINT_GAP - 120);
  });

  it('at phone width (400px) it stays within the margins', () => {
    const phone = { width: 400, height: 800 };
    const wide = { width: 400 - 2 * HINT_MARGIN, height: 160 };
    for (const left of [8, 120, 200, 372]) {
      const spot = placeHint(at(left, 100), wide, phone);
      expect(spot.left).toBeGreaterThanOrEqual(HINT_MARGIN);
      expect(spot.left + wide.width).toBeLessThanOrEqual(400 - HINT_MARGIN);
    }
  });
});

describe('doc hint: what it draws', () => {
  it('a button that never navigates, its popover with the title and the text, closed', () => {
    const html = renderToStaticMarkup(<DocHint to={DOC_PAGES.trustLevels} />);
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="About Trust levels"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-testid="doc-link"');
    expect(html).toMatch(/role="tooltip"[^>]*hidden=""/);
    expect(html).toContain('data-testid="doc-hint"');
    expect(html).toContain(DOC_PAGES.trustLevels.hint);
    expect(html).not.toContain('<a ');
  });

  it('without the docs root it has no Documentation line; with it, one in a new tab', () => {
    expect(renderToStaticMarkup(<DocHint to={DOC_PAGES.missions} />)).not.toContain(
      'doc-hint-link',
    );
    const html = renderToStaticMarkup(
      <DocsProvider root="https://docs.test/docs">
        <DocHint to={DOC_PAGES.missions} testId="page-doc-link" />
      </DocsProvider>,
    );
    expect(html).toContain('data-testid="page-doc-link"');
    expect(html).toContain('href="https://docs.test/docs/missions"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('data-testid="doc-hint-link"');
    expect(html).toContain('Documentation');
  });
});
