/**
 * The classes of `missions.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  quiet: 'vb-missions-quiet max-w-[var(--measure)] m-0 text-muted-foreground text-small',
  quietText: 'vb-missions-quietText text-muted-foreground',
  sub: 'vb-missions-sub block text-muted-foreground text-caption',
  name: 'vb-missions-name text-foreground font-semibold',
  link: 'vb-missions-link p-0 border-0 [background:none] text-primary [font-size:inherit] text-left cursor-pointer hover:underline',
  refused: 'vb-missions-refused ml-2 text-refused-fg text-caption [white-space:normal]',
  tone_bad: 'vb-missions-tone_bad text-refused-fg',
  tone_warn: 'vb-missions-tone_warn text-approval-fg',
  inlineTag: 'vb-missions-inlineTag ml-1.5',
  details: 'vb-missions-details [margin:-10px_0_22px] text-muted-foreground text-caption',
  headNote:
    'vb-missions-headNote [.vb-missions-details_+_&]:mt-[-14px] max-w-[var(--measure)] [margin:-10px_0_22px] text-muted-foreground text-small [&_a]:text-primary',
  block: 'vb-missions-block mb-7',
  afterSection: 'vb-missions-afterSection mt-[var(--section-gap)]',
  afterLine: 'vb-missions-afterLine mt-3',
  versionChanges:
    'vb-missions-versionChanges [margin:8px_0_0] pl-4 text-muted-foreground text-small',
  noteText: 'vb-missions-noteText min-w-0',
  keyChoice: 'vb-missions-keyChoice grid gap-2 mb-3',
  rowActions: 'vb-missions-rowActions inline-flex gap-1.5',
  openUntil: 'vb-missions-openUntil ml-1.5 text-muted-foreground text-caption',
  permissionLine: 'vb-missions-permissionLine block [.vb-missions-permissionLine_+_&]:mt-1',
  rowLinks: 'vb-missions-rowLinks inline-flex flex-wrap [gap:4px_12px] [&_a]:text-primary',
  pager:
    'vb-missions-pager flex gap-4 [margin:12px_0_0] text-muted-foreground text-small [&_a]:text-primary',
  reveal: 'vb-missions-reveal grid gap-5',
  kit: 'vb-missions-kit grid gap-4.5 min-w-0',
  kitStep: 'vb-missions-kitStep min-w-0 [&_pre]:max-h-[232px]',
  kitHead:
    'vb-missions-kitHead flex items-center gap-2.5 mb-2 [&_>_:first-child]:w-[20px] [&_>_:first-child]:h-[20px] max-[641px]:flex-wrap',
  kitTitle:
    'vb-missions-kitTitle m-0 text-small font-semibold max-[641px]:flex-1 max-[641px]:min-w-0',
  kitHint:
    'vb-missions-kitHint ml-auto text-muted-foreground text-small text-right max-[641px]:[flex-basis:100%] max-[641px]:ml-7.5 max-[641px]:text-left',
  nameRow:
    'vb-missions-nameRow grid [grid-template-columns:minmax(0,_1fr)_auto_auto] gap-2 items-center max-[901px]:[grid-template-columns:minmax(0,_1fr)]',
  startFrom: 'vb-missions-startFrom w-[190px] max-[901px]:w-full',
  proposal: 'vb-missions-proposal grid gap-2 mt-3',
  issueList: 'vb-missions-issueList [margin:4px_0_0] pl-4.5',
  accounts: 'vb-missions-accounts border-b border-b-border',
  account: 'vb-missions-account [padding:12px_0_14px] border-t border-t-border',
  accountOff: 'vb-missions-accountOff text-muted-foreground',
  accountHead:
    'vb-missions-accountHead flex items-center gap-3 min-h-[var(--control-sm)] text-small max-[901px]:flex-wrap',
  accountName: 'vb-missions-accountName text-body font-semibold whitespace-nowrap',
  accountHint: 'vb-missions-accountHint text-muted-foreground whitespace-nowrap',
  resourceNames:
    'vb-missions-resourceNames min-w-0 overflow-hidden [text-overflow:ellipsis] whitespace-nowrap',
  resourceCount: 'vb-missions-resourceCount flex-none text-muted-foreground whitespace-nowrap',
  figure: 'vb-missions-figure tabular-nums',
  accountResources:
    'vb-missions-accountResources flex items-center justify-end gap-2 min-w-0 ml-auto text-muted-foreground text-right [.vb-missions-accountOff_&]:text-muted-foreground max-[901px]:w-full max-[901px]:ml-[27px] max-[901px]:[justify-content:flex-start] max-[901px]:text-left',
  resourceScope:
    'vb-missions-resourceScope grid gap-1.5 [margin:10px_0_0_27px] text-small [&_p]:max-w-[var(--measure)] [&_p]:m-0',
  resources:
    'vb-missions-resources grid [grid-template-columns:repeat(auto-fill,_minmax(260px,_1fr))] [gap:6px_16px] [margin:10px_0_0_27px] [padding:10px_12px] [border-radius:var(--radius-md)] bg-sidebar text-small',
  resource: 'vb-missions-resource inline-flex flex-wrap items-center gap-1.5',
  accountBody: 'vb-missions-accountBody [padding:10px_0_0_27px]',
  everythingDescription:
    'vb-missions-everythingDescription max-w-[var(--measure)] [margin:10px_0_0] text-muted-foreground text-small',
  counts:
    'vb-missions-counts flex flex-wrap items-center [gap:4px_16px] mt-2 [&_>_span]:text-small',
  countsLink:
    'vb-missions-countsLink ml-auto p-0 border-0 [background:none] text-primary text-small hover:underline',
  viewPanel: 'vb-missions-viewPanel mt-2',
  macroActions: 'vb-missions-macroActions flex flex-col',
  macroAction:
    'vb-missions-macroAction grid [grid-template-columns:auto_minmax(0,_1fr)_auto] [gap:4px_12px] items-start [padding:6px_0] border-t border-t-border first:[border-top:0] [&_>_input]:mt-[3px] max-[641px]:[grid-template-columns:auto_minmax(0,_1fr)] max-[641px]:[&_>_fieldset]:[grid-column:2]',
  macroActionOff: 'vb-missions-macroActionOff',
  macroActionName:
    'vb-missions-macroActionName [.vb-missions-macroActionOff_&]:text-muted-foreground font-semibold cursor-pointer',
  macroActionText: 'vb-missions-macroActionText min-w-0',
  macroActionCounts:
    'vb-missions-macroActionCounts [margin:2px_0_0] text-muted-foreground text-caption',
  skipped:
    'vb-missions-skipped max-w-[var(--measure)] [margin:6px_0_0] text-approval-fg text-small',
  notice:
    'vb-missions-notice [margin:6px_0_0_27px] text-muted-foreground text-small [&_summary]:text-approval-fg [&_summary]:cursor-pointer',
  editor: 'vb-missions-editor [margin:12px_0_0]',
  ownLine: 'vb-missions-ownLine block mt-1',
  editorTools: 'vb-missions-editorTools flex flex-wrap items-center gap-2',
  editorFilter: 'vb-missions-editorFilter ml-auto',
  planeSelect: 'vb-missions-planeSelect w-[150px]',
  editorBulk:
    'vb-missions-editorBulk flex flex-wrap items-baseline [gap:4px_16px] [margin:8px_0] text-muted-foreground text-small',
  editorShown: 'vb-missions-editorShown ml-auto',
  limitInput: 'vb-missions-limitInput w-[84px] text-right tabular-nums',
  windowInput: 'vb-missions-windowInput w-[56px] text-right',
  rate: 'vb-missions-rate inline-flex items-center justify-end gap-1 text-muted-foreground text-caption',
  unavailableWhy: 'vb-missions-unavailableWhy block text-muted-foreground text-caption',
  refusedWhy: 'vb-missions-refusedWhy block text-muted-foreground text-caption text-refused-fg',
  people: 'vb-missions-people m-0 pt-1.5 text-muted-foreground text-small',
  expiryDate: 'vb-missions-expiryDate max-w-[260px] mt-3',
  railBlock:
    'vb-missions-railBlock [padding:10px_0] border-t border-t-border text-small first:pt-0 first:[border-top:0] last:pb-0',
  railAccount: 'vb-missions-railAccount mb-1 font-semibold',
  railResources: 'vb-missions-railResources block text-muted-foreground font-normal',
  railCarries:
    'vb-missions-railCarries grid [grid-template-columns:62px_minmax(0,_1fr)] [gap:4px_8px] m-0 [&_dt]:text-foreground [&_dd]:m-0 [&_dd]:text-muted-foreground',
  railEmpty: 'vb-missions-railEmpty m-0 text-muted-foreground text-small',
  railIssues:
    'vb-missions-railIssues [margin:12px_0_0] [padding:12px_0_0_18px] border-t border-t-border text-muted-foreground text-small',
  railRefused:
    'vb-missions-railRefused [margin:12px_0_0] [padding:12px_0_0_18px] border-t border-t-border text-muted-foreground text-small text-refused-fg [&p]:pl-0',
  railHint:
    'vb-missions-railHint ml-auto text-muted-foreground text-caption [line-height:1.3] text-right',
  limitsActions: 'vb-missions-limitsActions flex flex-wrap items-center [gap:8px_12px] mt-3',
  limitChanges:
    'vb-missions-limitChanges [margin:0_0_8px] pl-4 [&_li_+_li]:mt-1 [&_code]:text-muted-foreground [&_code]:text-caption',
  wrapAnywhere: 'vb-missions-wrapAnywhere [overflow-wrap:anywhere] min-w-0',
  resourceSet: 'vb-missions-resourceSet mt-3 pt-2 border-t border-t-border',
  resourceSetHead:
    'vb-missions-resourceSetHead flex flex-wrap items-center [gap:8px_12px] min-h-[var(--control-sm)] text-small',
  resourceSetTitle: 'vb-missions-resourceSetTitle font-semibold whitespace-nowrap',
  resourceSetScope: 'vb-missions-resourceSetScope w-auto',
  addResourceSet:
    'vb-missions-addResourceSet block w-full mt-3 [padding:8px_12px] border border-border-strong border-dashed [border-radius:var(--radius-md)] [background:none] text-muted-foreground [font:inherit] text-small text-left cursor-pointer hover:border-primary hover:text-primary',
  trustRaises: 'vb-missions-trustRaises grid gap-2',
  listFilter: 'vb-missions-listFilter [margin:-6px_0_18px]',
};

export default styles;
