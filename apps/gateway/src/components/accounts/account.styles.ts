/**
 * The classes of `account.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  quiet: 'vb-account-quiet text-muted-foreground',
  refreshing: 'vb-account-refreshing text-muted-foreground text-caption',
  strong: 'vb-account-strong font-semibold',
  notice: 'vb-account-notice mb-6 [&_p_+_p]:mt-1',
  named: 'vb-account-named flex items-center gap-2.5 min-w-0',
  namedText: 'vb-account-namedText flex flex-col min-w-0',
  name: 'vb-account-name font-semibold [&a:hover]:underline',
  sub: 'vb-account-sub text-muted-foreground text-caption',
  fact: 'vb-account-fact whitespace-nowrap',
  factNote: "vb-account-factNote text-muted-foreground before:[content:'_·_']",
  permissions:
    'vb-account-permissions grid [grid-template-columns:repeat(auto-fill,_minmax(320px,_1fr))] [gap:4px_24px] m-0 p-0 list-none text-small',
  permission: 'vb-account-permission flex flex-col min-w-0 [padding:4px_0]',
  permissionLabel: 'vb-account-permissionLabel inline-flex flex-wrap items-baseline gap-2',
  detailHead: 'vb-account-detailHead [margin:0_0_8px] text-muted-foreground text-caption',
  reveal: 'vb-account-reveal text-primary hover:underline',
  headWithDoc: 'vb-account-headWithDoc inline-flex items-center gap-1',
};

export default styles;
