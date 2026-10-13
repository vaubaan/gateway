/**
 * The line icons of the interface: sixteen-pixel drawings on a 24-unit grid,
 * drawn here rather than taken from an icon package. An icon never carries
 * information alone — it sits next to a word, or its control is named — so it
 * is hidden from assistive technology. No decorative icon: one is drawn only
 * where it names a destination (the side navigation) or an action.
 */
export type IconName =
  | 'now'
  | 'waiting'
  | 'missions'
  | 'accounts'
  | 'activity'
  | 'reference'
  | 'settings'
  | 'search'
  | 'sun'
  | 'moon'
  | 'system'
  | 'check'
  | 'cross'
  | 'alert'
  | 'info'
  | 'key'
  | 'copy'
  | 'chevron'
  | 'more'
  | 'signout';

/** Keyed by name: a new icon fails to compile until it is drawn. */
const PATHS: Readonly<Record<IconName, React.ReactNode>> = {
  now: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  waiting: (
    <>
      <path d="M3 13l2.2-7.2A1 1 0 0 1 6.2 5h11.6a1 1 0 0 1 1 .8L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    </>
  ),
  missions: (
    <>
      <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  accounts: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18M7 15h3" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  reference: <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16l-4-2-4 2-4-2-4 2z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  system: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  check: <path d="M5 12l5 5L20 7" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  alert: <path d="M12 8v5M12 16h.01" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  key: <path d="M15 7a4 4 0 1 1-2.5 7.1L8 18.6V21H5v-3l5.4-5.4A4 4 0 0 1 15 7z" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  signout: (
    <>
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
      <path d="M16 16l4-4-4-4M20 12H10" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  /** Drawn size in pixels; the stroke keeps its weight. */
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
