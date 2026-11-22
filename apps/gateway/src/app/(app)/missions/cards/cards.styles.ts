/**
 * The classes of `cards.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  cards: 'vb-cards-cards flex flex-col gap-4 [.vb-cards-lostBody_&]:mt-3',
  card: 'vb-cards-card border border-border [border-radius:var(--radius-lg)] bg-card',
  head: 'vb-cards-head flex flex-wrap items-center gap-2 [padding:12px_16px] border-b border-b-border',
  account: 'vb-cards-account text-foreground font-semibold',
  resources: 'vb-cards-resources min-w-0 text-muted-foreground text-small [overflow-wrap:anywhere]',
  headEnd: 'vb-cards-headEnd flex items-center gap-2 ml-auto',
  checked: 'vb-cards-checked text-muted-foreground text-caption',
  issues:
    'vb-cards-issues m-0 [padding:8px_16px_8px_32px] border-b border-b-border text-refused-fg text-small',
  table:
    'vb-cards-table w-full [border-collapse:collapse] [&_th]:[padding:8px_16px_4px] [&_th]:text-muted-foreground [&_th]:text-caption [&_th]:font-normal [&_th]:text-left max-[641px]:block max-[641px]:[&_tbody]:block max-[641px]:[&_thead]:hidden',
  row: 'vb-cards-row [&_td]:[padding:8px_16px] [&_td]:border-t [&_td]:border-t-border [&_td]:[vertical-align:middle] max-[641px]:grid max-[641px]:[grid-template-columns:auto_minmax(0,_1fr)] max-[641px]:border-t max-[641px]:border-t-border max-[641px]:[&_td]:[border-top:0]',
  rowOff: 'vb-cards-rowOff',
  what: 'vb-cards-what [.vb-cards-rowOff_&]:text-muted-foreground min-w-0',
  tick: 'vb-cards-tick w-[1px] pr-0!',
  actionName:
    'vb-cards-actionName block text-foreground font-semibold [.vb-cards-rowOff_&]:text-muted-foreground [.vb-cards-rowOff_&]:font-normal',
  actionDescription: 'vb-cards-actionDescription block text-muted-foreground text-caption',
  trust:
    'vb-cards-trust w-[1px] whitespace-nowrap max-[641px]:[grid-column:1_/_-1] max-[641px]:w-auto max-[641px]:min-w-0 max-[641px]:pt-0! max-[641px]:[white-space:normal]',
  today:
    'vb-cards-today w-[1px] min-w-[8rem] whitespace-nowrap max-[721px]:min-w-0 max-[641px]:[grid-column:1_/_-1] max-[641px]:w-auto max-[641px]:min-w-0 max-[641px]:pt-0! max-[641px]:[white-space:normal]',
  foot: 'vb-cards-foot [padding:8px_16px] border-t border-t-border text-muted-foreground text-caption',
  segments:
    'vb-cards-segments inline-flex m-0 p-0 border border-border-strong [border-radius:var(--radius-md)] overflow-hidden [vertical-align:middle]',
  segment:
    'vb-cards-segment relative inline-flex items-center [padding:0_8px] min-h-[var(--control-sm)] border-l border-l-border text-muted-foreground text-caption cursor-pointer [&:first-of-type]:[border-left:0] [&_input]:absolute [&_input]:inset-0 [&_input]:w-full [&_input]:h-full [&_input]:m-0 [&_input]:[opacity:0] [&_input]:[cursor:inherit] focus-within:[box-shadow:0_0_0_2px_var(--background),_0_0_0_4px_var(--ring)] [.vb-cards-segmentsOff_&]:[cursor:default]',
  segmentOn:
    'vb-cards-segmentOn bg-foreground [&.vb-cards-segmentOn]:text-background [.vb-cards-segmentsOff_&.vb-cards-segment:not()]:text-faint [.vb-cards-segmentsQuiet_&]:bg-muted [.vb-cards-segmentsQuiet_&]:text-muted-foreground',
  segmentsOff: 'vb-cards-segmentsOff',
  segmentsQuiet: 'vb-cards-segmentsQuiet',
  hover: 'vb-cards-hover relative inline-block ml-2 [vertical-align:middle]',
  info: 'vb-cards-info inline-flex items-center justify-center w-[20px] h-[20px] p-0 border border-border-strong [border-radius:var(--radius-full)] bg-background text-muted-foreground text-caption [font-style:italic] [cursor:help]',
  gaugeButton:
    'vb-cards-gaugeButton p-0 border-0 [background:none] [font:inherit] text-left [cursor:help]',
  popover:
    "vb-cards-popover absolute [z-index:20] [top:calc(100%_+_6px)] right-0 hidden [width:min(34rem,_86vw)] max-h-[60vh] p-3 border border-border-strong [border-radius:var(--radius-md)] bg-card [box-shadow:var(--shadow-overlay)] [overflow:auto] [white-space:normal] text-left before:absolute before:top-[-8px] before:right-0 before:left-0 before:h-[8px] before:[content:''] [.vb-cards-hover:hover_&]:block [.vb-cards-hover:focus-within_&]:block",
  popoverTitle: 'vb-cards-popoverTitle [margin:0_0_8px] text-foreground text-small font-semibold',
  popoverGroup:
    'vb-cards-popoverGroup [margin:8px_0_0] text-muted-foreground text-caption font-semibold',
  popoverList: 'vb-cards-popoverList [margin:4px_0_0] pl-4 text-muted-foreground text-caption',
  popoverNote: 'vb-cards-popoverNote block [margin:8px_0_0] text-muted-foreground text-caption',
  tools: 'vb-cards-tools flex flex-wrap items-center gap-2 mb-3 text-muted-foreground text-caption',
  permissions:
    'vb-cards-permissions w-full [border-collapse:collapse] text-small [&_th]:[padding:4px_8px] [&_th]:text-muted-foreground [&_th]:text-caption [&_th]:font-normal [&_th]:text-left [&_td]:[padding:4px_8px] [&_td]:border-t [&_td]:border-t-border [&_td]:[vertical-align:middle]',
  permissionRow: 'vb-cards-permissionRow block',
  permissionId:
    'vb-cards-permissionId block text-muted-foreground [font-family:var(--font-mono)] text-caption [overflow-wrap:anywhere]',
  number: 'vb-cards-number w-[5.5rem]',
  never: 'vb-cards-never text-muted-foreground',
  unavailable: 'vb-cards-unavailable block text-muted-foreground text-caption',
  planeNote: 'vb-cards-planeNote [margin:12px_0_0] text-muted-foreground text-caption',
  addRow: 'vb-cards-addRow flex flex-wrap items-center gap-2',
  marks: 'vb-cards-marks inline-flex gap-1',
  accountList: 'vb-cards-accountList flex flex-col [margin:12px_0_0] p-0 list-none',
  accountItem:
    'vb-cards-accountItem flex items-center gap-2 w-full p-2 border-0 border-t border-t-border [background:none] text-foreground [font:inherit] text-left cursor-pointer disabled:text-muted-foreground disabled:[cursor:not-allowed] [&:not(:disabled):hover]:bg-muted',
  accountFree: 'vb-cards-accountFree ml-auto text-muted-foreground text-caption',
  group:
    'vb-cards-group [margin:12px_0_0] [padding:8px_12px] border border-border [border-radius:var(--radius-md)]',
  groupOn: 'vb-cards-groupOn border-approval-border',
  groupHead: 'vb-cards-groupHead flex items-center gap-2 text-muted-foreground text-small',
  groupCount: 'vb-cards-groupCount text-muted-foreground text-caption',
  groupBody: 'vb-cards-groupBody flex flex-col gap-1 [margin:8px_0_0_24px]',
  groupNote: 'vb-cards-groupNote text-muted-foreground text-caption',
  groupSelectAll: 'vb-cards-groupSelectAll ml-auto',
  groupHidden:
    'vb-cards-groupHidden [&_summary]:cursor-pointer [&_summary]:text-muted-foreground [&_summary]:text-caption [&[open]_summary]:mb-1',
  groupHiddenList: 'vb-cards-groupHiddenList flex flex-col gap-1',
  bar: 'vb-cards-bar sticky [z-index:10] bottom-0 flex flex-wrap items-center gap-3 mt-6 [padding:12px_16px] border border-border-strong [border-radius:var(--radius-lg)] bg-card [box-shadow:var(--shadow-overlay)]',
  barText: 'vb-cards-barText [flex:1_1_16rem] min-w-0 text-muted-foreground text-small',
  barIssues: 'vb-cards-barIssues [margin:4px_0_0] pl-4 text-refused-fg text-small',
  barActions: 'vb-cards-barActions flex gap-2',
  fields:
    'vb-cards-fields grid [grid-template-columns:minmax(0,_2fr)_minmax(0,_1fr)_minmax(0,_1fr)] gap-3 mb-4 max-[721px]:[grid-template-columns:1fr]',
  checkNow:
    'vb-cards-checkNow p-0 border-0 [background:none] text-primary [font:inherit] cursor-pointer disabled:text-muted-foreground disabled:[cursor:progress]',
  checkError: 'vb-cards-checkError text-refused-fg',
  startRow: 'vb-cards-startRow flex flex-wrap items-center gap-2 mb-4',
  headWithDoc: 'vb-cards-headWithDoc inline-flex items-center gap-1',
  lostCard:
    'vb-cards-lostCard border border-refused-border [border-radius:var(--radius-lg)] bg-refused-bg',
  lostRemoving: 'vb-cards-lostRemoving [border-style:dashed]',
  lostHead: 'vb-cards-lostHead flex flex-wrap items-center gap-2 [padding:12px_16px_0]',
  lostLine:
    'vb-cards-lostLine [margin:4px_0_0] [padding:0_16px] text-refused-fg text-small [overflow-wrap:anywhere]',
  lostBody: 'vb-cards-lostBody [padding:8px_16px_12px]',
  lostDetails: 'vb-cards-lostDetails text-muted-foreground text-small [&_p]:[margin:0_0_8px]',
};

export default styles;
