'use client';

/**
 * The context of where one is: a small (i) that shows, in a popover beside
 * it, the target's label in bold, a few sentences explaining the page or the
 * concept, and a last line "Documentation ↗" that opens its page of the user
 * docs in a new tab (docs/handbook/web-app.md, "doc hints"). The (i) itself
 * never navigates: leaving the page is an explicit click inside the popover.
 *
 * - At the right of a page's title (`PageHeader`'s `doc`), on every page that
 *   has a page in the docs.
 * - Inside a form, beside a concept that trips people (a trust level, the
 *   resources found later, an environment label): a few, no more.
 *
 * It opens on hover (after a short delay) and on focus; a click or a tap pins
 * it open, a second one closes it; Escape and a click outside close it. It
 * stays open while the pointer travels from the (i) into the popover, so its
 * link is reachable, and it is placed to stay inside the viewport. While it
 * only follows the pointer or the focus it is a `tooltip`; pinned, it is a
 * non-modal `dialog` named by its title.
 *
 * The target is an entry of `DOC_PAGES` or `serviceDoc` (`lib/vocabulary.ts`),
 * never a text or a path written in a page. The docs root comes from the
 * instance's configuration (`docs.url`) through `DocsProvider`, which the shell
 * renders; outside it (a test, the gallery's previews) the hint shows its text
 * without the Documentation line.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';

import { docHref } from '@/lib/docs-links';
import { docHintLabel, docLinkLabel, type DocTarget } from '@/lib/vocabulary';

import styles from './DocHint.module.css';

const DocsRootContext = createContext<string | null>(null);

/** Rendered by the shell with `root.config.docs.url`. */
export function DocsProvider({ root, children }: { root: string; children: React.ReactNode }) {
  return <DocsRootContext.Provider value={root}>{children}</DocsRootContext.Provider>;
}

// ─────────────────────────────────────────────────────────────────────────────
// What keeps the hint open: pure, unit-tested (tests/unit/app/doc-hint.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Why the hint is open: the pointer rests on it, the focus is in it, or a click pinned it. */
export interface HintState {
  readonly hovered: boolean;
  readonly focused: boolean;
  readonly pinned: boolean;
}

export type HintEvent =
  | 'pointer-in'
  | 'pointer-out'
  | 'focus-in'
  | 'focus-out'
  /** A click or a tap on the (i). */
  | 'toggle'
  | 'escape'
  | 'outside';

export const HINT_CLOSED: HintState = { hovered: false, focused: false, pinned: false };

export function hintReducer(state: HintState, event: HintEvent): HintState {
  switch (event) {
    case 'pointer-in':
      return { ...state, hovered: true };
    case 'pointer-out':
      return { ...state, hovered: false };
    case 'focus-in':
      return { ...state, focused: true };
    case 'focus-out':
      return { ...state, focused: false };
    // A click on a hint the pointer or the focus opened pins it, so that it
    // stays once they leave; a click on a pinned hint closes it altogether.
    case 'toggle':
      return state.pinned ? HINT_CLOSED : { ...state, pinned: true };
    case 'escape':
    case 'outside':
      return HINT_CLOSED;
  }
}

export function hintOpen(state: HintState): boolean {
  return state.hovered || state.focused || state.pinned;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The gap between the (i) and the popover, and the least margin to the viewport's edges. */
export const HINT_GAP = 6;
export const HINT_MARGIN = 16;

/**
 * Where the popover goes, in the viewport's coordinates: below the (i) and
 * starting at its left edge; flipped to end at its right edge when that runs
 * past the viewport, above it when there is no room below and more above, and
 * finally pushed inside the margins.
 */
export function placeHint(
  trigger: Box,
  popover: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { left: number; top: number; above: boolean } {
  const maxLeft = viewport.width - HINT_MARGIN - popover.width;
  let left = trigger.left;
  if (left > maxLeft) left = trigger.left + trigger.width - popover.width;
  left = Math.max(HINT_MARGIN, Math.min(left, maxLeft));

  const below = trigger.top + trigger.height + HINT_GAP;
  const roomBelow = viewport.height - HINT_MARGIN - below;
  const roomAbove = trigger.top - HINT_GAP - HINT_MARGIN;
  const above = popover.height > roomBelow && roomAbove > roomBelow;
  const top = above ? trigger.top - HINT_GAP - popover.height : below;
  return { left, top, above };
}

/** How long the pointer rests on the (i) before the hint opens, and may be away before it closes. */
const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 150;

// ─────────────────────────────────────────────────────────────────────────────
// The component
// ─────────────────────────────────────────────────────────────────────────────

export function DocHint({ to, testId }: { to: DocTarget; testId?: string }) {
  const root = useContext(DocsRootContext);
  const [state, dispatch] = useReducer(hintReducer, HINT_CLOSED);
  const open = hintOpen(state);
  const wrapper = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returning = useRef(false);
  const [place, setPlace] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const popoverId = useId();
  const titleId = useId();
  const textId = useId();

  const later = useCallback((event: HintEvent, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      dispatch(event);
    }, ms);
  }, []);
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  // Placed before it is painted, again when the window scrolls or resizes. The
  // position is the popover's offset from the (i)'s wrapper, which is its
  // containing block: it moves with the page on its own.
  const measure = useCallback(() => {
    const at = trigger.current?.getBoundingClientRect();
    const box = popover.current?.getBoundingClientRect();
    if (!at || !box) return;
    const spot = placeHint(
      at,
      { width: box.width, height: box.height },
      { width: document.documentElement.clientWidth, height: window.innerHeight },
    );
    setPlace({ left: spot.left - at.left, top: spot.top - at.top, above: spot.above });
  }, []);
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  // Escape closes it (the focus goes back to the (i) when it was inside), a
  // press outside closes it.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      cancel();
      const active = document.activeElement;
      const inside = active !== trigger.current && (wrapper.current?.contains(active) ?? false);
      dispatch('escape');
      if (inside) {
        // The focus comes back to the (i) without opening the hint again.
        returning.current = true;
        trigger.current?.focus();
      }
    }
    function onPointer(event: PointerEvent) {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) {
        cancel();
        dispatch('outside');
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [open, cancel]);

  const pinned = state.pinned;
  // Spans throughout: the hint sits in a title line, a table head or a label.
  return (
    <span
      ref={wrapper}
      className={styles.hint}
      // A finger has no hover: a tap is a click, handled by `toggle`.
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') later('pointer-in', OPEN_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') later('pointer-out', CLOSE_DELAY_MS);
      }}
      onFocus={() => {
        if (returning.current) returning.current = false;
        else dispatch('focus-in');
      }}
      onBlur={(event) => {
        if (!(
          event.relatedTarget instanceof Node && wrapper.current?.contains(event.relatedTarget)
        ))
          dispatch('focus-out');
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label={docHintLabel(to)}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-describedby={textId}
        data-testid={testId ?? 'doc-link'}
        onClick={() => {
          cancel();
          dispatch('toggle');
        }}
      >
        <span aria-hidden="true">i</span>
      </button>
      <span
        ref={popover}
        id={popoverId}
        role={pinned ? 'dialog' : 'tooltip'}
        aria-modal={pinned ? false : undefined}
        aria-labelledby={pinned ? titleId : undefined}
        className={styles.popover}
        data-above={place?.above ? 'true' : undefined}
        style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}
        hidden={!open}
        data-testid="doc-hint"
      >
        <span id={titleId} className={styles.title}>
          {to.label}
        </span>
        <span id={textId} className={styles.text}>
          {to.hint}
        </span>
        {root && (
          <a
            className={styles.link}
            href={docHref(root, to)}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={docLinkLabel(to)}
            data-testid="doc-hint-link"
          >
            Documentation <span aria-hidden="true">↗</span>
          </a>
        )}
      </span>
    </span>
  );
}
