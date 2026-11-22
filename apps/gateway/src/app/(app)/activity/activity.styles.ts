/**
 * The classes of `activity.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  quiet: 'vb-activity-quiet text-muted-foreground',
  sub: 'vb-activity-sub block text-muted-foreground text-caption [.vb-activity-onText_&]:overflow-hidden [.vb-activity-onText_&]:[text-overflow:ellipsis] [.vb-activity-onText_&]:whitespace-nowrap',
  problems: 'vb-activity-problems mb-4',
  filters: 'vb-activity-filters flex flex-col gap-2 mb-3',
  filterRow: 'vb-activity-filterRow flex flex-wrap items-center gap-2',
  select: 'vb-activity-select w-auto max-w-[220px]',
  tool: 'vb-activity-tool w-[190px]',
  clear: 'vb-activity-clear text-primary text-small',
  moreFilters:
    'vb-activity-moreFilters grid [grid-template-columns:repeat(auto-fill,_minmax(220px,_1fr))] [gap:12px_16px] max-w-[980px] pb-2',
  time: 'vb-activity-time text-muted-foreground tabular-nums [scroll-margin-top:48px]',
  who: 'vb-activity-who inline-flex items-center gap-1.5 min-w-0',
  whoText: 'vb-activity-whoText flex flex-col min-w-0 [overflow-wrap:anywhere]',
  onText: 'vb-activity-onText flex flex-col min-w-0',
  permission:
    'vb-activity-permission [display:-webkit-box] overflow-hidden text-muted-foreground [-webkit-box-orient:vertical] [-webkit-line-clamp:2]',
  when: 'vb-activity-when inline-flex flex-col',
  decision: 'vb-activity-decision inline-flex flex-wrap items-baseline [gap:4px_6px]',
  refused: 'vb-activity-refused text-refused-fg',
  detailLink: 'vb-activity-detailLink text-primary text-caption whitespace-nowrap hover:underline',
  touched: 'vb-activity-touched flex flex-col gap-0.5',
  told: 'vb-activity-told block max-w-[78ch] mt-0.5 text-muted-foreground',
  state: 'vb-activity-state max-w-[860px] mt-3',
  toolbar: 'vb-activity-toolbar flex flex-wrap items-center justify-between [gap:8px_16px] mb-2.5',
  region:
    'vb-activity-region [max-height:max(320px,_calc(100dvh_-_340px))] [overflow:auto] [overscroll-behavior:contain] border-b border-b-border max-[641px]:max-h-[none]',
  pager: 'vb-activity-pager flex flex-wrap items-center [gap:8px_16px] text-small',
  pagerLines: 'vb-activity-pagerLines text-muted-foreground tabular-nums',
  pagerSteps: 'vb-activity-pagerSteps inline-flex items-center gap-3',
  pagerLink: 'vb-activity-pagerLink text-primary hover:underline',
  pagerOff: 'vb-activity-pagerOff text-muted-foreground [opacity:0.6]',
  mission:
    'vb-activity-mission block overflow-hidden max-w-[18ch] text-muted-foreground text-caption [text-overflow:ellipsis] whitespace-nowrap',
  check: 'vb-activity-check inline-flex items-center gap-1.5 text-muted-foreground text-small',
  missionLinks: 'vb-activity-missionLinks m-0 text-muted-foreground text-small [&_a]:text-primary',
};

export default styles;
