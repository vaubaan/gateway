/**
 * The classes of `accounts.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  form: 'vb-accounts-form flex flex-col gap-3.5 max-w-[560px]',
  formActions: 'vb-accounts-formActions flex flex-wrap items-center gap-2 mt-2',
  formHint: 'vb-accounts-formHint ml-auto text-muted-foreground text-caption',
  prose:
    'vb-accounts-prose max-w-[var(--measure)] text-muted-foreground text-small [&_p]:m-0 [&_p_+_p]:mt-2 [&_a]:text-primary',
  stack: 'vb-accounts-stack flex flex-col gap-4',
  notes: 'vb-accounts-notes flex flex-col gap-3 mb-6',
  facts: 'vb-accounts-facts mb-6',
  holder: 'vb-accounts-holder inline-flex items-center gap-2 min-w-0',
  holderName: 'vb-accounts-holderName font-semibold',
  holderNote: 'vb-accounts-holderNote text-muted-foreground',
  editor:
    'vb-accounts-editor grid [grid-template-columns:minmax(0,_1.4fr)_minmax(0,_1fr)] [gap:12px_20px] max-w-[760px] max-[721px]:[grid-template-columns:minmax(0,_1fr)]',
  editorWide: 'vb-accounts-editorWide [grid-column:1_/_-1]',
  editorActions: 'vb-accounts-editorActions flex items-center gap-2 [grid-column:1_/_-1]',
  inlineForm: 'vb-accounts-inlineForm inline',
  linkButton:
    'vb-accounts-linkButton p-0 border-0 [background:none] text-primary text-small hover:underline',
  dangerLink: 'vb-accounts-dangerLink text-refused-fg',
  closing:
    'vb-accounts-closing flex flex-wrap items-center gap-3 mt-[var(--section-gap)] text-muted-foreground text-small',
  key: 'vb-accounts-key max-w-[760px]',
  target:
    'vb-accounts-target grid [grid-template-columns:150px_minmax(0,_1fr)] gap-3 items-start max-[561px]:[grid-template-columns:minmax(0,_1fr)]',
  starts:
    'vb-accounts-starts flex flex-wrap items-center gap-1.5 mt-4 text-muted-foreground text-small',
  startsEnd: 'vb-accounts-startsEnd inline-flex gap-2 ml-auto',
  checklist: 'vb-accounts-checklist mt-2 border-t border-t-border border-b border-b-border',
  macroActionOn:
    'vb-accounts-macroActionOn border-foreground [box-shadow:inset_0_0_0_1px_var(--foreground)]',
  summary: 'vb-accounts-summary [margin:12px_0_0] text-muted-foreground text-small',
  dialogNotes: 'vb-accounts-dialogNotes flex flex-col gap-2 mt-3',
  restores: 'vb-accounts-restores [margin:8px_0_0] pl-5 text-small [&_li_+_li]:mt-1',
  guided:
    "vb-accounts-guided flex flex-col gap-8 [&:has([data-alternative-choice='0']:checked)_[data-alternative-panel]:not([data-alternative-panel='0'])]:hidden [&:has([data-alternative-choice='1']:checked)_[data-alternative-panel]:not([data-alternative-panel='1'])]:hidden [&:has([data-alternative-choice='2']:checked)_[data-alternative-panel]:not([data-alternative-panel='2'])]:hidden [&:has([data-alternative-choice='3']:checked)_[data-alternative-panel]:not([data-alternative-panel='3'])]:hidden",
};

export default styles;
