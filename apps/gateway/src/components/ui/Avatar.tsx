/**
 * Who, at a glance: a person is a round teal mark with initials, a team the
 * same mark squared a little, a machine key a dashed square, a service its
 * brand icon in one ink — the shape says which, the colour never does
 * (style guide §5). `hueOf` gives a name its stable hue (1–5), which the two
 * letters of a service without an icon take; none of the hues is a status
 * colour.
 *
 * - `Avatar`, `AvatarStack` — the mark, alone or overlapped.
 * - `KeyHolder` — the mark, the name, and the qualifiers said in words
 *   ("· you · creator", "· machine key").
 * - `ServiceMark` — the icon the service's plugin declares, in its brand
 *   colour on a neutral fill (a near-black brand takes the ink in the dark
 *   theme, `darkThemeMarkColor`); two letters on a hue (GitHub → GH) when it
 *   declares none (ADR service-icons-declared-by-the-plugin).
 * - `KeyMark` — a masked key in mono with the key icon.
 * - `AgentLabel` — the name an agent gave itself (never verified).
 *
 * shadcn/ui's Avatar look, written for Vaubaan on the shared tokens (`human`,
 * `chart-1…5`); no image is ever loaded.
 */
import type { CSSProperties } from 'react';

import { serviceMarkColors } from '@vaubaan/shared/service-mark';

import { cn } from '@/lib/utils';

import { Icon } from './Icon.tsx';

const HUES = 5;

/** The fill of a hue: the shared chart family, never a status colour. 0 is the quiet slate. */
const HUE_FILL: readonly string[] = [
  'bg-chart-5',
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
];

const AVATAR_SIZE: Readonly<Record<AvatarSize, string>> = {
  xs: 'size-[18px] text-[9px]',
  sm: 'size-[22px] text-[10.5px]',
  md: 'size-[30px] text-caption',
};

/** A stable hue (1–5) from a name: the same string always gives the same one. */
export function hueOf(name: string): number {
  // FNV-1a: short names that differ by a letter land on different hues.
  let hash = 0x811c9dc5;
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % HUES) + 1;
}

/** "Alice Chen" → AC; "alice@acme.com" → AL; "github-actions" → GA. */
export function initialsOf(name: string): string {
  const local = name.includes('@') ? (name.split('@')[0] ?? name) : name;
  const words = local.split(/[\s._\-/]+/).filter(Boolean);
  const first = words[0] ?? '';
  const second = words[1] ?? '';
  const letters = second ? `${first.charAt(0)}${second.charAt(0)}` : first.slice(0, 2);
  return letters.toUpperCase() || '?';
}

export type AvatarSize = 'xs' | 'sm' | 'md';
export type HolderKind = 'person' | 'machine' | 'team';

export function Avatar({
  name,
  kind = 'person',
  size = 'sm',
  muted = false,
  initials,
}: {
  /** The full name or email; said to assistive technology unless the name is printed beside. */
  name: string;
  /** A machine key has no person behind it: a dashed square. */
  kind?: HolderKind;
  size?: AvatarSize;
  /** A person who is not active any more: no hue. */
  muted?: boolean;
  initials?: string;
}) {
  const machine = kind === 'machine';
  return (
    <span
      className={cn(
        'inline-grid flex-none select-none place-items-center align-middle leading-none font-semibold tracking-normal',
        AVATAR_SIZE[size],
        machine
          ? // A machine key: no person behind it. Dashed, squared, no hue.
            'border border-dashed border-border-strong bg-muted text-muted-foreground'
          : muted
            ? 'bg-chart-5 text-primary-foreground'
            : 'bg-human text-on-human',
        machine || kind === 'team' ? (size === 'md' ? 'rounded-lg' : 'rounded-md') : 'rounded-full',
      )}
      data-kind={kind}
      data-hue={machine || muted ? 0 : hueOf(name)}
      title={name}
      aria-hidden="true"
    >
      {initials ?? initialsOf(name)}
    </span>
  );
}

export interface StackMember {
  readonly name: string;
  readonly kind?: HolderKind;
}

/** At most `max` marks, overlapped; the names are read out as one sentence. */
export function AvatarStack({
  members,
  max = 4,
}: {
  members: readonly StackMember[];
  max?: number;
}) {
  const shown = members.slice(0, max);
  const hidden = members.length - shown.length;
  return (
    <span
      // Overlapped: each mark is a little larger and ringed with the paper.
      className="inline-flex items-center [&>[data-kind]]:-ml-1.5 [&>[data-kind]]:size-6 [&>[data-kind]]:border-2 [&>[data-kind]]:border-solid [&>[data-kind]]:border-background [&>[data-kind]:first-child]:ml-0"
      role="img"
      aria-label={members.map((m) => m.name).join(', ')}
    >
      {shown.map((member) => (
        <Avatar key={`${member.kind ?? 'person'}:${member.name}`} {...member} />
      ))}
      {hidden > 0 && <span className="ml-1 text-caption text-muted-foreground">+{hidden}</span>}
    </span>
  );
}

export function KeyHolder({
  name,
  kind = 'person',
  qualifier,
  size = 'sm',
  muted = false,
}: {
  name: string;
  kind?: HolderKind;
  /** What is said after the name, already in words: "· you · creator", "· machine key". */
  qualifier?: React.ReactNode;
  size?: AvatarSize;
  muted?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar name={name} kind={kind} size={size} muted={muted} />
      <span className="min-w-0">
        <span className="font-semibold">{name}</span>
        {qualifier && <span className="font-normal text-muted-foreground"> {qualifier}</span>}
      </span>
    </span>
  );
}

/** "GitHub" → GH, "Upstash Redis" → UR, "Supabase" → SU. */
export function serviceLetters(name: string): string {
  const words = name.split(/[\s\-_/]+/).filter(Boolean);
  if (words.length > 1)
    return `${words[0]?.charAt(0) ?? ''}${words[1]?.charAt(0) ?? ''}`.toUpperCase();
  const capitals = name.replace(/[^A-Z]/g, '');
  return (capitals.length >= 2 ? capitals.slice(0, 2) : name.slice(0, 2)).toUpperCase();
}

/**
 * The mark of a service as the registry hands it out (`ServiceIcon` of the
 * plugin SDK, spelled here so that a client component bundles no server
 * package): the `d` of its icon on a 24-unit grid and the brand colour it is
 * drawn in, `null` when the plugin declares none.
 */
export interface ServiceMarkIcon {
  readonly path: string;
  readonly color: string | null;
}

/**
 * The colour a mark takes in the dark theme: the brand colour itself, or
 * the ink (`--foreground`) when the brand is near black (it would vanish on the dark paper).
 * `#RRGGBB` in, a CSS colour out. The rule is `serviceMarkColors`
 * (`@vaubaan/shared/service-mark`), the one the public site draws with too.
 */
export function darkThemeMarkColor(hex: string): string {
  return serviceMarkColors(hex).dark ?? 'var(--foreground)';
}

export function ServiceMark({
  name,
  icon = null,
  size = 'sm',
}: {
  /** The service's display name, from the plugin registry. */
  name: string;
  /**
   * The service's mark from the registry (`serviceIconOf`): the `d` of its
   * icon on a 24-unit grid and the brand colour it is drawn in; `null` or
   * absent for a plugin that declares no icon.
   */
  icon?: ServiceMarkIcon | null;
  size?: 'sm' | 'lg';
}) {
  const box = cn(
    'inline-grid flex-none select-none place-items-center align-middle leading-none font-semibold tracking-normal',
    size === 'lg' ? 'size-[34px] rounded-lg text-small' : 'size-5 rounded-[5px] text-[9.5px]',
  );
  if (icon) {
    // Without a colour the mark keeps the secondary ink: the fallback of its class.
    const style = icon.color
      ? ({
          '--mark-color': icon.color,
          '--mark-color-dark': darkThemeMarkColor(icon.color),
        } as CSSProperties)
      : undefined;
    return (
      <span
        // The brand icon on the neutral fill, in the brand colour the plugin declares (the
        // secondary ink without one); never a hue, never a status. In the dark theme a
        // near-black brand takes the ink (ServiceMark sets both variables).
        className={cn(
          box,
          'bg-muted text-[color:var(--mark-color,var(--muted-foreground))] theme-dark:text-[color:var(--mark-color-dark,var(--muted-foreground))]',
        )}
        style={style}
        aria-hidden="true"
        data-mark="icon"
        data-size={size}
      >
        <svg
          viewBox="0 0 24 24"
          className={cn('block', size === 'lg' ? 'size-[22px]' : 'size-3.5')}
          focusable="false"
        >
          <path d={icon.path} fill="currentColor" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={cn(box, HUE_FILL[hueOf(name)], 'text-primary-foreground')}
      data-mark="letters"
      data-size={size}
      data-hue={hueOf(name)}
      aria-hidden="true"
    >
      {serviceLetters(name)}
    </span>
  );
}

/** A masked key (`vbn_live_XU2O…6uT`): mono, with the key icon. Never the whole secret. */
export function KeyMark({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[5px] whitespace-nowrap font-mono text-caption text-muted-foreground">
      <Icon name="key" size={11} className="flex-none" />
      {children}
    </span>
  );
}

/** The label an agent sent about itself. It never authorises anything. */
export function AgentLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap text-caption text-muted-foreground before:size-[5px] before:rounded-full before:bg-faint before:content-['']"
      title="What the agent said about itself; not verified"
    >
      {children}
    </span>
  );
}
