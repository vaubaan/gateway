/**
 * The classes of `reference.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  inline: 'vb-reference-inline inline-flex flex-wrap items-center gap-2',
  rowTag: 'vb-reference-rowTag ml-2 font-normal',
  strip:
    'vb-reference-strip flex flex-wrap items-center [gap:8px_20px] [margin:0_0_20px] [padding:8px_12px] border border-border [border-radius:var(--radius-lg)] bg-sidebar text-muted-foreground text-small',
  wrapAnywhere: 'vb-reference-wrapAnywhere [overflow-wrap:anywhere] min-w-0',
  servicePage:
    'vb-reference-servicePage min-w-0 [--pp-accent:var(--primary)] [--pp-accent-ink:var(--primary-ink)] [--pp-accent-soft:var(--primary-soft)] [--pp-ask-bg:var(--approval-bg)] [--pp-ask-ink:var(--approval-fg)] [--pp-ask-line:var(--approval-border)] [--pp-bad:var(--refused-fg)] [--pp-bad-line:var(--refused-border)] [--pp-env-bg:var(--muted)] [--pp-env-ink:var(--muted-foreground)] [--pp-env-line:var(--border-strong)] [--pp-fill:var(--muted)] [--pp-focus-ring:0_0_0_2px_var(--background),_0_0_0_4px_var(--ring)] [--pp-font-mono:var(--font-mono)] [--pp-ink:var(--foreground)] [--pp-ink-2:var(--muted-foreground)] [--pp-ink-3:var(--muted-foreground)] [--pp-leading-tight:1.375] [--pp-line:var(--border)] [--pp-line-strong:var(--border-strong)] [--pp-measure:var(--measure)] [--pp-ok:var(--allowed-fg)] [--pp-paper:var(--background)] [--pp-paper-side:var(--sidebar)] [--pp-path-bg:var(--approval-bg)] [--pp-path-ink:var(--foreground)] [--pp-path-line:var(--approval-border)] [--pp-radius-lg:var(--radius-lg)] [--pp-radius-md:var(--radius-md)] [--pp-radius-sm:var(--radius-sm)] [--pp-row1-bg:var(--allowed-bg)] [--pp-row1-line:var(--allowed-bg)] [--pp-row1-ink:var(--allowed-fg)] [--pp-row2-bg:var(--primary-soft)] [--pp-row2-line:var(--primary-soft)] [--pp-row2-ink:var(--primary-ink)] [--pp-row3-bg:var(--approval-bg)] [--pp-row3-line:var(--approval-bg)] [--pp-row3-ink:var(--approval-fg)] [--pp-row4-bg:var(--refused-bg)] [--pp-row4-line:var(--refused-bg)] [--pp-row4-ink:var(--refused-fg)] [--pp-space-1:4px] [--pp-space-2:8px] [--pp-space-3:12px] [--pp-space-4:16px] [--pp-space-6:24px] [--pp-space-8:32px] [--pp-space-10:40px] [--pp-space-12:48px] [--pp-text-xs:var(--text-caption)] [--pp-text-sm:var(--text-small)] [--pp-text-base:var(--text-body)] [--pp-text-lg:var(--text-body)] [--pp-text-title:var(--text-title)] [--pp-text-hero:var(--text-title)] [--pp-text-section:var(--text-title)] [--pp-text-card:var(--text-body)] [--pp-text-column:var(--text-body)] [--pp-tip-bg:var(--foreground)] [--pp-tip-ink:var(--background)] [--pp-warn-line:var(--approval-border)] [--pp-warn-soft:var(--approval-bg)] [--pp-weight-regular:400] [--pp-weight-strong:600] [--pp-yes-bg:var(--allowed-bg)] [--pp-yes-line:var(--allowed-border)]',
};

export default styles;
