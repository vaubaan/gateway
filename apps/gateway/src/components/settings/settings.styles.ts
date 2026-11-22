/**
 * The classes of `settings.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  quiet: 'vb-settings-quiet text-muted-foreground',
  sub: 'vb-settings-sub block text-muted-foreground text-caption',
  name: 'vb-settings-name font-semibold',
  inline: 'vb-settings-inline inline-flex flex-wrap items-center gap-2',
  named: 'vb-settings-named flex items-center gap-2.5 min-w-0',
  namedText: 'vb-settings-namedText flex flex-col min-w-0',
  reveal: 'vb-settings-reveal text-primary hover:underline',
  notes: 'vb-settings-notes flex flex-col gap-3 mb-6 [&_p_+_p]:mt-1',
  list: 'vb-settings-list [margin:4px_0_0] pl-5',
  form: 'vb-settings-form flex flex-col gap-3.5 max-w-[560px]',
  formActions: 'vb-settings-formActions flex flex-wrap items-center gap-2 mt-1',
  formHint: 'vb-settings-formHint text-muted-foreground text-caption',
  lineForm:
    'vb-settings-lineForm flex flex-wrap items-end gap-2 max-w-[560px] [&_>_:first-child]:flex-1 [&_>_:first-child]:min-w-[220px]',
  claims:
    'vb-settings-claims grid [grid-template-columns:repeat(3,_minmax(0,_1fr))] gap-2 max-[721px]:[grid-template-columns:minmax(0,_1fr)]',
  inlineForm: 'vb-settings-inlineForm inline',
  fieldset: 'vb-settings-fieldset contents min-w-0 m-0 p-0 border-0',
  prose:
    'vb-settings-prose max-w-[var(--measure)] text-muted-foreground text-small [&_p]:m-0 [&_p_+_p]:mt-2',
  block: 'vb-settings-block max-w-[760px]',
  detail: 'vb-settings-detail flex flex-col gap-4',
  members: 'vb-settings-members flex flex-col gap-1 m-0 p-0 list-none',
  member: 'vb-settings-member flex items-center gap-3',
};

export default styles;
