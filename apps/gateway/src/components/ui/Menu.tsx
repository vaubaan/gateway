'use client';

/**
 * Everything else a page offers, behind "···" (style guide §1: one primary
 * action, at most two secondary ones visible, the rest behind "···").
 *
 * `MoreMenu` is the button and its panel; `MenuItem` is one act — a button,
 * or a link when it navigates. The panel is one of the few surfaces with a
 * shadow. shadcn/ui's DropdownMenu on Radix (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site): it closes on
 * Escape (the focus goes back to the button), on a click outside and once an
 * item was chosen; the arrow keys move between its items, typing a letter
 * finds one. `danger` draws the words of an act that stops something in red:
 * never a red fill.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { buttonVariants } from './Button.tsx';
import { Icon } from './Icon.tsx';

/** The panel goes on the themed island the menu sits in (the gallery's dark one), else the body. */
function useIslandContainer(): [React.RefObject<HTMLSpanElement | null>, HTMLElement | null] {
  const anchor = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const island = anchor.current?.closest<HTMLElement>('[data-theme]');
    setContainer(island && island !== document.documentElement ? island : document.body);
  }, []);
  return [anchor, container];
}

export function MoreMenu({
  label = 'More actions',
  children,
  testId,
}: {
  /** Names the button for assistive technology and on hover. */
  label?: string;
  /** `MenuItem`s. */
  children: React.ReactNode;
  testId?: string;
}) {
  const [anchor, container] = useIslandContainer();
  return (
    <span ref={anchor} className="relative inline-flex">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          // Drawn as a secondary Button of the same size, so that it reads as one of its
          // neighbours in a page header, not as a faint glyph beside them.
          className={cn(
            buttonVariants({ variant: 'secondary', size: 'md' }),
            'w-8 px-0 data-[state=open]:bg-accent [&_svg]:[stroke-width:3]',
          )}
          aria-label={label}
          title={label}
          data-testid={testId}
        >
          <Icon name="more" size={16} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={container}>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 flex min-w-[200px] flex-col rounded-lg bg-popover p-1 text-popover-foreground shadow-md outline-none"
          >
            {children}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
}

export function MenuItem({
  children,
  href,
  onSelect,
  danger = false,
  disabled = false,
  note,
}: {
  /** The act, as a verb: "Replace key", "Stop the mission". */
  children: React.ReactNode;
  /** An item that navigates is a link. */
  href?: string;
  onSelect?: () => void;
  /** An act that stops or removes something. */
  danger?: boolean;
  disabled?: boolean;
  /** A few quiet words under the act: what it does, or why it is not available. */
  note?: React.ReactNode;
}) {
  const classes = cn(
    'flex w-full cursor-pointer flex-col gap-0.5 whitespace-nowrap rounded-md px-2.5 py-[7px] text-left text-body no-underline outline-none hover:no-underline data-highlighted:bg-accent data-disabled:cursor-not-allowed data-disabled:text-faint',
    danger ? 'text-destructive' : 'text-popover-foreground',
  );
  const content = (
    <>
      <span>{children}</span>
      {note && <span className="text-caption whitespace-normal text-muted-foreground">{note}</span>}
    </>
  );
  if (href && !disabled) {
    return (
      <DropdownMenu.Item asChild className={classes}>
        <Link href={href}>{content}</Link>
      </DropdownMenu.Item>
    );
  }
  return (
    <DropdownMenu.Item className={classes} disabled={disabled} onSelect={() => onSelect?.()}>
      {content}
    </DropdownMenu.Item>
  );
}
