'use client';

/**
 * The filters of an Activity tab: a GET form whose values take effect as they
 * are chosen. A select or a checkbox applies at once; a typed value (a tool, a
 * person, a label, a date — whose digits can be typed one by one) applies on
 * Enter or once the typing pauses.
 * The address is built from the form's values, the empty ones left out, and
 * followed like a link: the page is rendered again by the server, from its
 * address, like any other page of the record — nothing here reads it.
 *
 * The fields are uncontrolled (the server fills their `defaultValue`), and a
 * field React keeps does not take a new default: when the address changes by
 * another way (a period, "Clear", Back), each field the reader is not typing
 * in is set to what the address says.
 *
 * Without JavaScript the form is a plain GET form, and the submit button the
 * page puts in a `<noscript>` applies it.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useTransition, type ChangeEvent, type KeyboardEvent } from 'react';

/** How long typing pauses before a typed value applies. */
const TYPING_PAUSE_MS = 700;

/** Controls whose change is a choice, not typing: they apply at once. */
function isChoice(target: EventTarget): boolean {
  if (target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')
  );
}

/** The address of the form's current values: the empty ones are not filters. */
function addressOf(form: HTMLFormElement): string {
  const params = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value === 'string' && value.trim() !== '') params.append(name, value.trim());
  }
  const query = params.toString();
  const action = new URL(form.action, window.location.href).pathname;
  return query ? `${action}?${query}` : action;
}

/** Sets each named field to the address's value, except the one being typed in. */
function syncFields(form: HTMLFormElement, params: URLSearchParams): void {
  for (const element of Array.from(form.elements)) {
    if (element === document.activeElement) continue;
    if (element instanceof HTMLSelectElement) {
      element.value = params.get(element.name) ?? '';
    } else if (element instanceof HTMLInputElement && element.name) {
      if (element.type === 'checkbox') element.checked = params.get(element.name) === element.value;
      else element.value = params.get(element.name) ?? '';
    }
  }
}

export function FilterForm({
  action,
  className,
  children,
}: {
  action: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const form = useRef<HTMLFormElement>(null);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    // From here a choice applies at once (before it, the page is a plain GET form):
    // `data-live` says so to whoever waits for it, a browser test among them.
    if (form.current) form.current.dataset.live = 'true';
    return () => {
      if (typing.current) clearTimeout(typing.current);
    };
  }, []);

  useEffect(() => {
    if (form.current) syncFields(form.current, new URLSearchParams(params.toString()));
  }, [params]);

  function apply(): void {
    if (typing.current) clearTimeout(typing.current);
    typing.current = null;
    const node = form.current;
    if (!node) return;
    const href = addressOf(node);
    if (href === `${window.location.pathname}${window.location.search}`) return;
    startTransition(() => {
      router.push(href, { scroll: false });
    });
  }

  function onChange(event: ChangeEvent<HTMLFormElement>): void {
    if (isChoice(event.target)) {
      apply();
      return;
    }
    if (typing.current) clearTimeout(typing.current);
    typing.current = setTimeout(apply, TYPING_PAUSE_MS);
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      apply();
    }
  }

  return (
    <form
      ref={form}
      method="get"
      action={action}
      className={className}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      aria-busy={pending || undefined}
      data-testid="activity-filters"
    >
      {children}
    </form>
  );
}
