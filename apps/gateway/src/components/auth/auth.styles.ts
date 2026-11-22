/**
 * The classes of `auth.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  wrap: 'vb-auth-wrap max-w-[480px] [margin:0_auto] [padding:48px_24px_48px]',
  wide: 'vb-auth-wide max-w-[760px]',
  title: 'vb-auth-title text-title [letter-spacing:-0.02em] [margin:0_0_4px]',
  lead: 'vb-auth-lead text-muted-foreground [margin:0_0_24px]',
  identity: 'vb-auth-identity flex items-center justify-between gap-3 flex-wrap',
  email: 'vb-auth-email font-normal',
  muted: 'vb-auth-muted text-muted-foreground text-small',
  inlineForm: 'vb-auth-inlineForm inline',
  actions: 'vb-auth-actions flex gap-3 items-center flex-wrap',
  groupList: 'vb-auth-groupList flex flex-wrap gap-2',
  dl: 'vb-auth-dl grid [grid-template-columns:max-content_1fr] [gap:8px_16px] m-0 [&_dt]:text-muted-foreground [&_dd]:m-0',
  page: 'vb-auth-page flex flex-col min-h-[100vh] bg-background',
  column: 'vb-auth-column flex-1 w-full max-w-[440px] [margin:0_auto] [padding:18vh_24px_48px]',
  brand: 'vb-auth-brand flex items-center gap-[9px] mb-8',
  brandMark: 'vb-auth-brandMark inline-flex size-[26px] flex-none text-foreground',
  brandText: 'vb-auth-brandText flex flex-col min-w-0 [line-height:1.2]',
  brandName: 'vb-auth-brandName text-body font-semibold',
  brandInstance:
    'vb-auth-brandInstance text-muted-foreground text-caption [overflow-wrap:anywhere]',
  heading:
    'vb-auth-heading m-0 text-title font-semibold [line-height:1.375] [letter-spacing:var(--tracking-title)]',
  sentence: 'vb-auth-sentence [margin:4px_0_0] text-muted-foreground text-small',
  block: 'vb-auth-block mt-6',
  act: 'vb-auth-act flex flex-wrap items-center [gap:8px_12px] mt-6 [&_a:not([class])]:text-primary [&_a:not([class])]:text-small',
  who: 'vb-auth-who mt-6 [padding:16px_0] border-t border-t-border border-b border-b-border',
  whoName:
    'vb-auth-whoName flex flex-wrap items-center gap-2 font-semibold [overflow-wrap:anywhere]',
  whoFacts: 'vb-auth-whoFacts mt-0.5 text-muted-foreground text-small',
  field: 'vb-auth-field mt-6',
  reference: 'vb-auth-reference mt-4 text-muted-foreground text-caption',
  qr: 'vb-auth-qr block w-[200px] h-[200px] [margin:0_auto_1rem] [border-radius:8px]',
};

export default styles;
