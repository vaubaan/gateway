/**
 * Who, at a glance: a person is a round mark with initials, a machine key is a
 * dashed square, a service is its brand icon in one ink — the shape says
 * which, the colour never does. The hue of a person is taken from their name
 * (`hueOf`), so the same person has the same mark on every page; it is
 * decoration and carries no meaning, which is why none of the five hues is a
 * status colour.
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
 */
import type { CSSProperties } from 'react';

import { Icon } from './Icon.tsx';
import styles from './Avatar.module.css';

const HUES = 5;

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
      className={[
        styles.avatar,
        styles[`size_${size}`],
        machine ? styles.machine : '',
        kind === 'team' ? styles.team : '',
      ].join(' ')}
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
    <span className={styles.stack} role="img" aria-label={members.map((m) => m.name).join(', ')}>
      {shown.map((member) => (
        <Avatar key={`${member.kind ?? 'person'}:${member.name}`} {...member} />
      ))}
      {hidden > 0 && <span className={styles.more}>+{hidden}</span>}
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
    <span className={styles.holder}>
      <Avatar name={name} kind={kind} size={size} muted={muted} />
      <span className={styles.holderText}>
        <span className={styles.holderName}>{name}</span>
        {qualifier && <span className={styles.qualifier}> {qualifier}</span>}
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
 * Below this relative luminance (sRGB, 0 to 1) a brand colour is close enough
 * to black to vanish on the dark paper: GitHub's #181717 is 0.006, Fly.io's
 * #24175B 0.017; Stripe's #635BFF, the darkest one kept, is 0.17.
 */
const NEAR_BLACK_LUMINANCE = 0.1;

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

/** sRGB channel (0–255) to linear light, per WCAG 2. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The colour a mark takes in the dark theme: the brand colour itself, or
 * the ink when the brand is near black (it would vanish on the dark paper).
 * `#RRGGBB` in, a CSS colour out.
 */
export function darkThemeMarkColor(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return hex;
  const [r, g, b] = match.slice(1).map((pair) => Number.parseInt(pair, 16)) as [
    number,
    number,
    number,
  ];
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance < NEAR_BLACK_LUMINANCE ? 'var(--ink)' : hex;
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
  const sizeClass = size === 'lg' ? styles.serviceLg : '';
  if (icon) {
    // Without a colour the mark keeps the secondary ink: the stylesheet's fallback.
    const style = icon.color
      ? ({
          '--mark-color': icon.color,
          '--mark-color-dark': darkThemeMarkColor(icon.color),
        } as CSSProperties)
      : undefined;
    return (
      <span
        className={[styles.service, styles.serviceIcon, sizeClass].join(' ')}
        style={style}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" className={styles.serviceGlyph} focusable="false">
          <path d={icon.path} fill="currentColor" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={[styles.service, sizeClass].join(' ')}
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
    <span className={styles.key}>
      <Icon name="key" size={11} className={styles.keyIcon} />
      {children}
    </span>
  );
}

/** The label an agent sent about itself. It never authorises anything. */
export function AgentLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className={styles.agent} title="What the agent said about itself; not verified">
      {children}
    </span>
  );
}
