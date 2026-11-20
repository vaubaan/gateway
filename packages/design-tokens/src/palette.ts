/**
 * The palette (style guide §3.1): every colour of the app and the site, light
 * and dark, chosen as sRGB hex and written to CSS as OKLCH (`render.ts`). The
 * contrast pairs below are the documented text–surface pairs; the unit test
 * holds each to its target in both themes.
 *
 * ADR: docs/decisions/design-system-on-shadcn-shared-by-the-app-and-the-site.md.
 * Handbook: docs/handbook/design-tokens.md.
 */

/** One token: its name without `--`, its light and dark values (sRGB hex), and what it is for. */
export interface Token {
  readonly name: string;
  readonly light: string;
  readonly dark: string;
  readonly note: string;
}

/** A documented pair: text (or a mark) on a surface, and the contrast it must reach. */
export interface ContrastPair {
  readonly fg: string;
  readonly bg: string;
  /** 4.5 for text, 3 for large text, a control boundary or a glyph (WCAG 1.4.11), 0 for none (documented). */
  readonly target: 0 | 3 | 4.5;
  readonly use: string;
}

const t = (name: string, light: string, dark: string, note = ''): Token => ({
  name,
  light,
  dark,
  note,
});

/** shadcn/ui's variable names, in shadcn's order: its components read these and nothing else. */
export const SHADCN_TOKENS: readonly Token[] = [
  t('background', '#fbfbf9', '#0e1215', 'page: plan paper'),
  t('foreground', '#1b2128', '#e8ecef', 'ink: text, the mark'),
  t('card', '#ffffff', '#151a1f', 'the one filled box, dialogs'),
  t('card-foreground', '#1b2128', '#e8ecef'),
  t('popover', '#ffffff', '#181e24', 'menus, tooltips-as-cards, command'),
  t('popover-foreground', '#1b2128', '#e8ecef'),
  t('primary', '#2f55c7', '#8fb0ff', 'the accent: primary action, links, focus'),
  t('primary-foreground', '#ffffff', '#0e1215'),
  t('secondary', '#f1f2f4', '#1c2228', 'secondary button fill (the vault)'),
  t('secondary-foreground', '#1b2128', '#e8ecef'),
  t('muted', '#f1f2f4', '#1c2228', 'quiet fills: inline code, skeleton, tags'),
  t('muted-foreground', '#56606b', '#a3adb7', 'secondary text (ink-2)'),
  t('accent', '#eceef1', '#222a31', 'shadcn accent = hover/current fill, not the brand accent'),
  t('accent-foreground', '#1b2128', '#e8ecef'),
  t('destructive', '#b4141f', '#ff8a8a', 'red words (danger never fills)'),
  t('destructive-foreground', '#ffffff', '#0e1215', 'kept for libraries that still read it'),
  t('border', '#dde1e6', '#2a333b', 'hairline'),
  t('input', '#858e99', '#6b7682', 'control boundary, 3:1 (WCAG 1.4.11)'),
  t('ring', '#2f55c7', '#8fb0ff', 'focus ring = accent'),
  t('chart-1', '#2f55c7', '#8fb0ff', 'accent'),
  t('chart-2', '#7a5fd0', '#a990f0', 'agent purple'),
  t('chart-3', '#18837d', '#4fc2b9', 'teal'),
  t('chart-4', '#c2417a', '#f07aa8', 'raspberry'),
  t('chart-5', '#6b7682', '#a3adb7', 'slate (other)'),
  t('sidebar', '#f4f5f3', '#11161a', 'side navigation'),
  t('sidebar-foreground', '#1b2128', '#e8ecef'),
  t('sidebar-primary', '#2f55c7', '#8fb0ff'),
  t('sidebar-primary-foreground', '#ffffff', '#0e1215'),
  t('sidebar-accent', '#e6e8eb', '#1f262d', 'current entry: a fill + 600, never a colour'),
  t('sidebar-accent-foreground', '#1b2128', '#e8ecef'),
  t('sidebar-border', '#e1e4e8', '#232b32'),
  t('sidebar-ring', '#2f55c7', '#8fb0ff'),
];

/** Vaubaan's extensions: the ink ladder, the accent's soft forms, the rows, the decisions, the trust levels, the actors, code. */
export const VAUBAAN_TOKENS: readonly Token[] = [
  t('faint', '#8a939d', '#6b7681', 'placeholder, disabled: below AA on purpose'),
  t('border-strong', '#b4bcc6', '#3c4751', 'card edge on paper'),
  t('primary-soft', '#e8edfb', '#17254a', 'accent band, selected row, info callout'),
  t('primary-ink', '#1f3f9e', '#cbd9ff', 'accent text on primary-soft; link hover'),
  t('row-1-fg', '#005f2e', '#a1e3b7', 'Harmless: green, light fill'),
  t('row-1-bg', '#dff8e6', '#173221'),
  t('row-1-border', '#a6e3bb', '#2c5a3b'),
  t('row-2-fg', '#434e5a', '#c8d2dd', 'Worth a look: cool grey'),
  t('row-2-bg', '#edf1f5', '#282c30'),
  t('row-2-border', '#cfd7e0', '#41474e'),
  t('row-3-fg', '#663b63', '#eac3e5', 'Repairable, at a price: soft plum'),
  t('row-3-bg', '#faebf8', '#342633'),
  t('row-3-border', '#e6c3e2', '#5a4058'),
  t('row-4-fg', '#70155a', '#ffbcee', 'Cannot be repaired: deep plum, weight 600'),
  t('row-4-bg', '#ffdcf8', '#48203c'),
  t('row-4-border', '#f1a6dd', '#74365f'),
  t(
    'approval',
    '#2f55c7',
    '#8fb0ff',
    'waiting for you / ask me first: the accent family (your move)',
  ),
  t('approval-fg', '#1f3f9e', '#cbd9ff', 'words'),
  t('approval-bg', '#e8edfb', '#17254a', 'the one filled box of a page that waits'),
  t('approval-border', '#b9c8f2', '#2c437f'),
  t('on-approval', '#ffffff', '#0e1215', 'text on the solid count'),
  t(
    'refused',
    '#c81e2a',
    '#ff6b6b',
    'refused, stopped, limit reached: glyph. the one meaning of red',
  ),
  t('refused-fg', '#a3121e', '#ffa3a3', 'words'),
  t('refused-bg', '#fde4e4', '#3f1215'),
  t('refused-border', '#f4b0b0', '#7a2228'),
  t('allowed', '#13995a', '#3ddc84', 'runs freely / done: glyph (explanations, checklists only)'),
  t('allowed-fg', '#0b6b3c', '#7eeaaa', 'words'),
  t('allowed-bg', '#dcf7e7', '#0d3320'),
  t('allowed-border', '#9fe0bb', '#1f6b42'),
  t('trust-careful', '#6b7682', '#a3adb7', 'mark'),
  t('trust-careful-fg', '#3f4852', '#d4dae0'),
  t('trust-careful-bg', '#f1f2f4', '#1c2228'),
  t('trust-trusting', '#2f55c7', '#8fb0ff'),
  t('trust-trusting-fg', '#1f3f9e', '#cbd9ff'),
  t('trust-trusting-bg', '#e8edfb', '#17254a'),
  t('trust-autonomous', '#7a5fd0', '#a990f0'),
  t('trust-autonomous-fg', '#4e3a99', '#d6cbfa'),
  t('trust-autonomous-bg', '#efeafb', '#26203d'),
  t('human', '#0b7f77', '#3cc9bd', 'the person: avatar disc (teal)'),
  t('human-fg', '#0b5f59', '#8ee6dc'),
  t('human-bg', '#d8f3f0', '#0d302d'),
  t('on-human', '#ffffff', '#0e1215'),
  t('agent', '#7a5fd0', '#a990f0', 'the agent: avatar disc'),
  t('agent-fg', '#4e3a99', '#d6cbfa'),
  t('agent-bg', '#efeafb', '#26203d'),
  t('on-agent', '#ffffff', '#0e1215'),
  t('code', '#15191d', '#0b0e11'),
  t('code-fg', '#e6eaee', '#e6eaee'),
  t('code-muted', '#97a1ac', '#8b96a1'),
  t('code-ok', '#5cc48a', '#5cc48a'),
  t('code-warn', '#9db7ff', '#9db7ff'),
  t('code-stop', '#f08a76', '#f08a76'),
  t('code-accent', '#8fb0ff', '#8fb0ff'),
  t('code-border', '#2a3138', '#232a31'),
  t('scrim', '#1b2128', '#000000', 'used at 40 % / 60 %'),
];

export const TOKENS: readonly Token[] = [...SHADCN_TOKENS, ...VAUBAAN_TOKENS];

const p = (fg: string, bg: string, target: ContrastPair['target'], use: string): ContrastPair => ({
  fg,
  bg,
  target,
  use,
});

/** Every documented pair (style guide §6, §7): checked in both themes by `tests/unit/contrast.test.ts`. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  p('foreground', 'background', 4.5, 'body text'),
  p('foreground', 'card', 4.5, 'text on card'),
  p('foreground', 'sidebar', 4.5, 'nav entries'),
  p('sidebar-accent-foreground', 'sidebar-accent', 4.5, 'current nav entry'),
  p('muted-foreground', 'background', 4.5, 'secondary text'),
  p('muted-foreground', 'card', 4.5, 'secondary text on card'),
  p('muted-foreground', 'muted', 4.5, 'secondary text on quiet fill'),
  p('muted-foreground', 'sidebar', 4.5, 'section label in nav'),
  p('muted-foreground', 'accent', 4.5, 'secondary text on hovered row'),
  p('secondary-foreground', 'secondary', 4.5, 'secondary button'),
  p('accent-foreground', 'accent', 4.5, 'ghost button hover'),
  p('popover-foreground', 'popover', 4.5, 'menu item'),
  p('primary', 'background', 4.5, 'link'),
  p('primary', 'card', 4.5, 'link on card'),
  p('primary-foreground', 'primary', 4.5, 'primary button label'),
  p('primary-ink', 'primary-soft', 4.5, 'info callout, selected row'),
  p('foreground', 'primary-soft', 4.5, 'body in info callout'),
  p('destructive', 'background', 4.5, 'danger words'),
  p('destructive', 'card', 4.5, 'danger words on card/menu'),
  p('destructive', 'secondary', 4.5, 'danger button (secondary fill)'),
  p('destructive-foreground', 'destructive', 4.5, 'legacy fill (not used by Vaubaan)'),
  p('input', 'background', 3, 'input boundary (non-text)'),
  p('input', 'card', 3, 'input boundary on card (non-text)'),
  p('ring', 'background', 3, 'focus ring (non-text)'),
  p('faint', 'background', 0, 'placeholder: below AA on purpose'),
  p('row-1-fg', 'row-1-bg', 4.5, 'RowBadge Harmless'),
  p('row-2-fg', 'row-2-bg', 4.5, 'RowBadge Worth a look'),
  p('row-3-fg', 'row-3-bg', 4.5, 'RowBadge Repairable, at a price'),
  p('row-4-fg', 'row-4-bg', 4.5, 'RowBadge Cannot be repaired'),
  p('row-1-fg', 'card', 4.5, 'row word in a table'),
  p('row-2-fg', 'card', 4.5, 'row word in a table'),
  p('row-3-fg', 'card', 4.5, 'row word in a table'),
  p('row-4-fg', 'card', 4.5, 'row word in a table'),
  p('row-1-fg', 'background', 4.5, 'row word on paper'),
  p('row-2-fg', 'background', 4.5, 'row word on paper'),
  p('row-3-fg', 'background', 4.5, 'row word on paper'),
  p('row-4-fg', 'background', 4.5, 'row word on paper'),
  p('approval-fg', 'approval-bg', 4.5, 'ApprovalCard text'),
  p('foreground', 'approval-bg', 4.5, 'ApprovalCard statement'),
  p('muted-foreground', 'approval-bg', 4.5, 'ApprovalCard meta'),
  p('approval-fg', 'card', 4.5, 'GateMark "ask me first"'),
  p('approval-fg', 'background', 4.5, 'GateMark on paper'),
  p('approval', 'card', 3, 'approval glyph (non-text)'),
  p('on-approval', 'approval', 4.5, 'nav count on the accent'),
  p('refused-fg', 'refused-bg', 4.5, 'RefusalCallout text'),
  p('foreground', 'refused-bg', 4.5, 'RefusalCallout body'),
  p('muted-foreground', 'refused-bg', 4.5, 'RefusalCallout meta'),
  p('refused-fg', 'card', 4.5, 'refused word in a row'),
  p('refused', 'card', 3, 'refused glyph (non-text)'),
  p('allowed-fg', 'allowed-bg', 4.5, 'checklist done, site "runs freely"'),
  p('allowed-fg', 'card', 4.5, 'done word'),
  p('allowed', 'card', 3, 'allowed glyph (non-text)'),
  p('trust-careful-fg', 'trust-careful-bg', 4.5, 'TrustLevelPicker chosen'),
  p('trust-trusting-fg', 'trust-trusting-bg', 4.5, 'TrustLevelPicker chosen'),
  p('trust-autonomous-fg', 'trust-autonomous-bg', 4.5, 'TrustLevelPicker chosen'),
  p('trust-careful', 'card', 3, 'trust gauge (non-text)'),
  p('trust-trusting', 'card', 3, 'trust gauge (non-text)'),
  p('trust-autonomous', 'card', 3, 'trust gauge (non-text)'),
  p('human-fg', 'human-bg', 4.5, 'human band title'),
  p('agent-fg', 'agent-bg', 4.5, 'agent band title'),
  p('on-human', 'human', 4.5, 'initials on the person disc'),
  p('human-fg', 'card', 4.5, 'person band words'),
  p('on-agent', 'agent', 4.5, 'glyph on the agent disc'),
  p('agent', 'card', 3, 'agent disc (non-text)'),
  p('human', 'card', 3, 'person disc (non-text)'),
  p('code-fg', 'code', 4.5, 'code text'),
  p('code-muted', 'code', 4.5, 'code comment'),
  p('code-ok', 'code', 4.5, 'terminal ok'),
  p('code-warn', 'code', 4.5, 'terminal ask'),
  p('code-stop', 'code', 4.5, 'terminal refused'),
  p('code-accent', 'code', 4.5, 'terminal prompt/link'),
  p('chart-1', 'card', 3, 'chart series (non-text)'),
  p('chart-2', 'card', 3, 'chart series (non-text)'),
  p('chart-3', 'card', 3, 'chart series (non-text)'),
  p('chart-4', 'card', 3, 'chart series (non-text)'),
  p('chart-5', 'card', 3, 'chart series (non-text)'),
];
