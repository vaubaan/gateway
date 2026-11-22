/**
 * The classes of `overview.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  expiring: 'vb-overview-expiring mb-4',
  expiryList: 'vb-overview-expiryList m-0 pl-4 [&_a]:text-primary',
  missions:
    'vb-overview-missions grid [grid-template-columns:repeat(auto-fill,_minmax(min(100%,_340px),_1fr))] [gap:24px_32px] mb-4',
  mission: 'vb-overview-mission flex flex-col gap-3 min-w-0 pt-3 border-t border-t-border',
  head: 'vb-overview-head flex flex-wrap items-center gap-2',
  name: 'vb-overview-name m-0 text-body font-semibold [overflow-wrap:anywhere] [&_a]:text-foreground',
  figure:
    'vb-overview-figure [color:inherit] no-underline hover:text-primary hover:underline focus-visible:text-primary focus-visible:underline',
  detail: 'vb-overview-detail flex flex-col gap-2 pt-2',
  heading: 'vb-overview-heading [margin:8px_0_0] text-muted-foreground text-caption font-normal',
  meter: 'vb-overview-meter [color:inherit] no-underline',
  links: 'vb-overview-links m-0 text-muted-foreground text-small [&_a]:text-primary',
};

export default styles;
