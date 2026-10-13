/**
 * The one glyph set of the interface: a dozen 12-pixel line drawings, drawn
 * here rather than taken from an icon package. A glyph never carries
 * information alone — it sits next to a word, or its parent names it — so it
 * is hidden from assistive technology.
 */
import type { ItemKind } from './kinds.ts';

export type GlyphName =
  | ItemKind
  | 'help'
  | 'chevron'
  | 'warning'
  | 'info'
  | 'key'
  | 'flask'
  | 'archive'
  | 'user';

const PERSON = (
  <>
    <circle cx="6" cy="4" r="2.2" />
    <path d="M1.8 10.6c.5-2 2.1-3 4.2-3s3.7 1 4.2 3" />
  </>
);

const KEY = (
  <>
    <circle cx="3.9" cy="6" r="2.2" />
    <path d="M6.1 6h4.4M8.9 6v2" />
  </>
);

/** Keyed by name: a new glyph fails to compile until it is drawn. */
const PATHS: Readonly<Record<GlyphName, React.ReactNode>> = {
  risk: <path d="M6 1.3 10.7 6 6 10.7 1.3 6Z" />,
  preset: <path d="M2 3h8M2 6h8M2 9h5" />,
  tool: <path d="M2 3.5 4.8 6 2 8.5M6.5 9H10" />,
  plane: <path d="M3 1.5v8h6.5M3 5.5h4.5" />,
  resource: (
    <>
      <rect x="2" y="2.5" width="8" height="7" rx="1" />
      <path d="M2 5.2h8" />
    </>
  ),
  connection: (
    <>
      <circle cx="4.2" cy="6" r="2.4" />
      <circle cx="7.8" cy="6" r="2.4" />
    </>
  ),
  mission: <path d="M3 11V1.6M3 2h6.2L7.6 4.4 9.2 6.8H3" />,
  member: PERSON,
  token: KEY,
  key: KEY,
  help: (
    <>
      <circle cx="6" cy="6" r="4.7" />
      <path d="M4.6 4.8a1.5 1.5 0 1 1 2.2 1.3c-.5.3-.8.6-.8 1.1M6 8.9v.1" />
    </>
  ),
  chevron: <path d="M4.2 2.5 7.8 6 4.2 9.5" />,
  warning: <path d="M6 1.6 11 10.2H1ZM6 5v2.4M6 8.8v.1" />,
  info: (
    <>
      <circle cx="6" cy="6" r="4.7" />
      <path d="M6 5.4v3M6 3.5v.1" />
    </>
  ),
  flask: <path d="M4.6 1.5h2.8M5 1.5v3L2.2 9.6a.6.6 0 0 0 .5.9h6.6a.6.6 0 0 0 .5-.9L7 4.5v-3" />,
  archive: (
    <>
      <rect x="1.5" y="2" width="9" height="2.6" rx=".6" />
      <path d="M2.4 4.6v5h7.2v-5M4.8 6.8h2.4" />
    </>
  ),
  user: PERSON,
};

export function Glyph({ name, className }: { name: GlyphName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
