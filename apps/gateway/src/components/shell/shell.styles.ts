/**
 * The classes of `shell.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  app: 'vb-shell-app grid [grid-template-columns:var(--side-width)_minmax(0,_1fr)] min-h-[100vh] max-[1024px]:[grid-template-columns:var(--side-width-collapsed)_minmax(0,_1fr)] max-[641px]:[--phone-bar:56px] max-[641px]:[grid-template-columns:minmax(0,_1fr)]',
  skip: 'vb-shell-skip absolute top-2 left-2 [z-index:300] [padding:8px_12px] [border-radius:var(--radius-md)] bg-foreground text-background text-small [transform:translateY(-200%)] [&:focus]:[transform:none]',
  side: 'vb-shell-side sticky top-0 flex flex-col gap-0.5 h-[100vh] [padding:14px_10px_12px] bg-sidebar max-[1024px]:items-center max-[1024px]:[padding:14px_8px_12px] max-[641px]:static max-[641px]:contents',
  brand:
    'vb-shell-brand flex items-center gap-[9px] mb-3 [padding:4px_8px] [border-radius:var(--radius-md)] hover:no-underline focus-visible:[border-radius:var(--radius-md)] focus-visible:[box-shadow:inset_0_0_0_2px_var(--background),_0_0_0_4px_var(--ring)] max-[1024px]:p-1 max-[641px]:hidden',
  brandMark: 'vb-shell-brandMark inline-flex size-[22px] flex-none text-foreground',
  brandText:
    'vb-shell-brandText flex flex-col min-w-0 [line-height:1.2] max-[1024px]:absolute max-[1024px]:w-[1px] max-[1024px]:h-[1px] max-[1024px]:m-[-1px] max-[1024px]:overflow-hidden max-[1024px]:[clip-path:inset(50%)] max-[1024px]:whitespace-nowrap',
  brandName: 'vb-shell-brandName text-body font-semibold',
  brandInstance:
    'vb-shell-brandInstance overflow-hidden text-muted-foreground text-caption [text-overflow:ellipsis] whitespace-nowrap',
  nav: 'vb-shell-nav min-h-0 [overflow-y:auto] max-[641px]:fixed max-[641px]:right-0 max-[641px]:bottom-0 max-[641px]:left-0 max-[641px]:[z-index:40] max-[641px]:[overflow:visible] max-[641px]:[padding:0_4px_env(safe-area-inset-bottom,_0)] max-[641px]:border-t max-[641px]:border-t-border max-[641px]:bg-sidebar',
  navList:
    'vb-shell-navList flex flex-col gap-0.5 m-0 p-0 list-none max-[641px]:grid max-[641px]:[grid-template-columns:repeat(5,_minmax(0,_1fr))] max-[641px]:gap-0',
  navRuled: 'vb-shell-navRuled mt-2 pt-2 border-t border-t-border',
  navLink:
    'vb-shell-navLink flex items-center gap-[9px] h-[var(--control-md)] [padding:0_8px] [border-radius:var(--radius-md)] text-muted-foreground text-body [transition:background_150ms_var(--ease-out)] hover:bg-muted hover:no-underline focus-visible:[border-radius:var(--radius-md)] focus-visible:[box-shadow:inset_0_0_0_2px_var(--background),_0_0_0_4px_var(--ring)] max-[1024px]:relative max-[1024px]:justify-center max-[1024px]:w-[40px] max-[1024px]:p-0 max-[641px]:flex-col max-[641px]:justify-center max-[641px]:gap-0.5 max-[641px]:w-full max-[641px]:h-[var(--phone-bar)] max-[641px]:[padding:0_2px] max-[641px]:border-0 max-[641px]:[background:none] max-[641px]:text-caption max-[641px]:[line-height:1.2] max-[641px]:hover:[background:none]',
  navIcon:
    'vb-shell-navIcon flex-none text-muted-foreground [.vb-shell-navLinkOn_&]:text-foreground',
  navLinkOn:
    'vb-shell-navLinkOn bg-muted [&.vb-shell-navLinkOn]:text-foreground font-semibold max-[641px]:[&.vb-shell-navLinkOn]:[background:none] max-[641px]:[&.vb-shell-navSheetLink]:bg-muted',
  navLabel:
    'vb-shell-navLabel overflow-hidden [text-overflow:ellipsis] whitespace-nowrap max-[1024px]:absolute max-[1024px]:w-[1px] max-[1024px]:h-[1px] max-[1024px]:m-[-1px] max-[1024px]:overflow-hidden max-[1024px]:[clip-path:inset(50%)] max-[1024px]:whitespace-nowrap max-[641px]:static max-[641px]:w-auto max-[641px]:max-w-full max-[641px]:h-auto max-[641px]:m-0 max-[641px]:overflow-hidden max-[641px]:[clip-path:none] max-[641px]:[text-overflow:ellipsis]',
  navLabelShort: 'vb-shell-navLabelShort hidden max-[641px]:block',
  navMore: 'vb-shell-navMore hidden max-[641px]:block max-[641px]:relative',
  navSheet:
    'vb-shell-navSheet m-0 p-0 list-none max-[641px]:absolute max-[641px]:right-1 max-[641px]:[bottom:calc(100%_+_8px)] max-[641px]:flex max-[641px]:flex-col max-[641px]:gap-0.5 max-[641px]:min-w-[190px] max-[641px]:p-1.5 max-[641px]:[border-radius:var(--radius-lg)] max-[641px]:bg-card max-[641px]:[box-shadow:var(--shadow-overlay)] max-[641px]:[&[hidden]]:hidden',
  navCount:
    'vb-shell-navCount grid [place-items:center] flex-none min-w-[18px] h-[18px] ml-auto [padding:0_5px] [border-radius:var(--radius-full)] bg-approval-fg text-on-approval text-caption font-semibold [line-height:1] tabular-nums max-[1024px]:absolute max-[1024px]:top-0 max-[1024px]:right-0 max-[1024px]:min-w-[16px] max-[1024px]:h-[16px] max-[1024px]:m-0 max-[1024px]:[padding:0_4px] max-[641px]:top-1.5 max-[641px]:[right:calc(50%_-_22px)]',
  bar: 'vb-shell-bar sticky top-0 [z-index:30] flex flex-none items-center gap-3 h-[var(--bar-height)] [padding:0_20px_0_16px] border-b border-b-border bg-background max-[641px]:[padding:0_12px]',
  path: 'vb-shell-path flex flex-1 items-center min-w-0 [overflow-x:auto] [scrollbar-width:none]',
  pathList:
    'vb-shell-pathList flex items-center gap-0.5 m-0 p-0 text-muted-foreground text-body list-none whitespace-nowrap',
  pathItem: 'vb-shell-pathItem inline-flex items-center gap-0.5',
  pathLink:
    'vb-shell-pathLink inline-flex items-center gap-[7px] h-[26px] [padding:0_6px] [border-radius:var(--radius-sm)] text-muted-foreground hover:bg-muted hover:text-foreground hover:no-underline',
  pathCurrent:
    'vb-shell-pathCurrent inline-flex items-center gap-[7px] h-[26px] [padding:0_6px] [border-radius:var(--radius-sm)] text-foreground font-semibold',
  pathSep: 'vb-shell-pathSep flex-none text-faint',
  pathMark:
    'vb-shell-pathMark grid [place-items:center] flex-none w-[18px] h-[18px] [border-radius:var(--radius-sm)] bg-primary text-primary-foreground text-caption font-semibold [line-height:1]',
  barEnd: 'vb-shell-barEnd flex flex-none items-center gap-1 ml-auto',
  user: 'vb-shell-user relative min-w-0',
  userButton:
    "vb-shell-userButton flex items-center gap-2 max-w-[240px] h-[var(--control-md)] [padding:0_8px_0_4px] border-0 [border-radius:var(--radius-md)] [background:none] text-foreground text-left hover:bg-muted [&[aria-expanded='true']]:bg-muted focus-visible:[border-radius:var(--radius-md)] max-[1024px]:[padding:0_4px]",
  userText:
    'vb-shell-userText flex flex-col min-w-0 [line-height:1.25] max-[1024px]:absolute max-[1024px]:w-[1px] max-[1024px]:h-[1px] max-[1024px]:m-[-1px] max-[1024px]:overflow-hidden max-[1024px]:[clip-path:inset(50%)] max-[1024px]:whitespace-nowrap',
  userName:
    'vb-shell-userName overflow-hidden [text-overflow:ellipsis] whitespace-nowrap text-body',
  userDetail:
    'vb-shell-userDetail overflow-hidden [text-overflow:ellipsis] whitespace-nowrap text-muted-foreground text-caption',
  userPanel:
    'vb-shell-userPanel absolute [top:calc(100%_+_4px)] right-0 [z-index:50] flex flex-wrap items-center gap-2 min-w-full p-2.5 [border-radius:var(--radius-lg)] bg-card [box-shadow:var(--shadow-overlay)] whitespace-nowrap [&[hidden]]:hidden max-[641px]:min-w-0',
  signOut: 'vb-shell-signOut inline-flex',
  themeToggle:
    'vb-shell-themeToggle grid [place-items:center] flex-none w-[var(--control-sm)] h-[var(--control-sm)] p-0 [border:1px_solid_transparent] [border-radius:var(--radius-md)] [background:none] text-muted-foreground hover:border-border-strong hover:text-foreground focus-visible:[border-radius:var(--radius-md)]',
  main: 'vb-shell-main flex flex-col min-w-0 min-h-[100vh] max-[641px]:min-h-0 max-[641px]:[padding-bottom:calc(var(--phone-bar)_+_env(safe-area-inset-bottom,_0))]',
  page: "vb-shell-page [.vb-shell-main_>_&]:[flex:1_0_auto] w-full max-w-[var(--page-max)] [margin:0_auto] [padding:var(--page-pad-top)_var(--page-pad-x)_var(--page-pad-bottom)] [&:focus]:[outline:none] [&:has([data-page-width='narrow'])]:max-w-[var(--page-max-narrow)] [&:has([data-page-width='wide'])]:max-w-[var(--page-max-wide)] max-[1024px]:[padding:24px_24px_48px] max-[641px]:[padding:20px_16px_40px]",
  buildFooter:
    'vb-shell-buildFooter mt-auto [padding:16px_var(--page-pad-x)] text-muted-foreground text-caption text-center max-[1024px]:[padding:16px_24px]',
  sideSub:
    'vb-shell-sideSub flex flex-col gap-2 min-h-0 mt-1 [overflow-y:auto] max-[1024px]:hidden',
  sideSubGroup: 'vb-shell-sideSubGroup flex flex-col gap-[1px]',
  sideSubLabel:
    'vb-shell-sideSubLabel [padding:4px_8px_2px_31px] text-muted-foreground text-caption',
  sideSubList: 'vb-shell-sideSubList flex flex-col gap-[1px] m-0 p-0 list-none',
  sideSubLink:
    'vb-shell-sideSubLink flex items-center h-[var(--control-sm)] [padding:0_8px_0_31px] [border-radius:var(--radius-md)] text-muted-foreground text-small whitespace-nowrap hover:bg-muted hover:no-underline focus-visible:[box-shadow:inset_0_0_0_2px_var(--background),_0_0_0_4px_var(--ring)]',
  sideSubLinkOn: 'vb-shell-sideSubLinkOn [&.vb-shell-sideSubLinkOn]:text-foreground font-semibold',
  settingsAbove: 'vb-shell-settingsAbove hidden max-[1024px]:contents',
  navBeyondBar: 'vb-shell-navBeyondBar max-[641px]:hidden',
  navLabelLong:
    'vb-shell-navLabelLong max-[641px]:[&.vb-shell-navLabelLong]:absolute max-[641px]:[&.vb-shell-navLabelLong]:w-[1px] max-[641px]:[&.vb-shell-navLabelLong]:h-[1px] max-[641px]:[&.vb-shell-navLabelLong]:m-[-1px] max-[641px]:[&.vb-shell-navLabelLong]:overflow-hidden max-[641px]:[&.vb-shell-navLabelLong]:[clip-path:inset(50%)]',
  navSheetLink:
    'vb-shell-navSheetLink max-[641px]:[flex-direction:row] max-[641px]:[justify-content:flex-start] max-[641px]:gap-2.5 max-[641px]:h-[44px] max-[641px]:[padding:0_12px] max-[641px]:text-body max-[641px]:hover:bg-muted',
};

export default styles;
