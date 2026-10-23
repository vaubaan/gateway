'use client';

/**
 * The end of the record's list: "Load earlier", a link to the same page with
 * one page more (`?lines=`), and a sentinel that follows it on its own when
 * the reader scrolls near the end. Following it replaces the address in place
 * (no history entry per page, no jump to the top): the server renders the
 * whole list again, the rows already shown keep their place and the next page
 * is appended under them. The rows stay server-rendered, read through the
 * same search as the first page; nothing here reads the record.
 *
 * Without JavaScript, or without `IntersectionObserver`, the link is a plain
 * link; with a keyboard, it is the button it looks like.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useTransition, type MouseEvent } from 'react';

import { ButtonLink } from '@/components/ui';
import { ACTIVITY_WORDS } from '@/lib/vocabulary';

import styles from './activity.module.css';

/** How far below the window the next page starts loading. */
const AHEAD = '600px 0px';

export function LoadEarlier({ href }: { href: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const sentinel = useRef<HTMLDivElement>(null);
  // The address last asked for: the observer and the button never ask twice for it.
  const asked = useRef<string | null>(null);

  const load = useCallback((): void => {
    if (asked.current === href) return;
    asked.current = href;
    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  }, [href, router]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (seen) => {
        if (seen.some((entry) => entry.isIntersecting)) load();
      },
      { rootMargin: AHEAD },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [load]);

  function onClick(event: MouseEvent<HTMLAnchorElement>): void {
    // A modified click (new tab, new window) is the browser's.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    load();
  }

  return (
    <div className={styles.more} data-testid="load-earlier">
      <div ref={sentinel} className={styles.sentinel} aria-hidden="true" />
      <ButtonLink
        href={href}
        size="sm"
        variant="ghost"
        onClick={onClick}
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
      >
        {ACTIVITY_WORDS.loadEarlier}
      </ButtonLink>
      <span className={styles.quiet} role="status" aria-live="polite">
        {pending ? ACTIVITY_WORDS.loadingEarlier : ''}
      </span>
    </div>
  );
}
