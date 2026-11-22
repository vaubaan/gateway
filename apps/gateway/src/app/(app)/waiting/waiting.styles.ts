/**
 * The classes of `waiting.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  request: 'vb-waiting-request min-w-0',
  notice: 'vb-waiting-notice mt-4',
  outcome:
    'vb-waiting-outcome max-w-[var(--measure)] [margin:8px_0_0] text-muted-foreground text-small',
  erased: 'vb-waiting-erased m-0 text-muted-foreground text-small',
  permission: 'vb-waiting-permission [.vb-waiting-permission_+_&]:mt-2',
  quiet: 'vb-waiting-quiet text-muted-foreground',
  none: 'vb-waiting-none text-refused-fg',
  slice: 'vb-waiting-slice block',
  more: 'vb-waiting-more mt-4',
  answer: 'vb-waiting-answer mt-6',
  answerTitle:
    'vb-waiting-answerTitle [margin:0_0_8px] text-muted-foreground text-caption font-normal',
  consequences:
    'vb-waiting-consequences grid [grid-template-columns:max-content_minmax(0,_1fr)] [gap:6px_16px] max-w-[760px] m-0 text-small [&_>_div]:contents [&_dt]:text-foreground [&_dt]:font-semibold [&_dd]:m-0 [&_dd]:text-muted-foreground max-[641px]:[grid-template-columns:minmax(0,_1fr)] max-[641px]:gap-0.5 max-[641px]:[&_>_div_+_div_dt]:mt-2',
  unavailable: 'vb-waiting-unavailable text-foreground',
  alternative: 'vb-waiting-alternative ml-auto max-[641px]:ml-0',
  choices: 'vb-waiting-choices grid gap-2 max-w-[620px] min-w-0 m-0 p-0 border-0',
  choiceInput:
    'vb-waiting-choiceInput flex flex-wrap items-center gap-2 [margin:8px_0_0_37px] text-small',
  amount: 'vb-waiting-amount w-[96px]',
  end: 'vb-waiting-end w-[220px]',
  notPossible: 'vb-waiting-notPossible block text-muted-foreground',
  empty: 'vb-waiting-empty max-w-[var(--measure)]',
};

export default styles;
