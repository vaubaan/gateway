/**
 * The classes of `design.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  section: 'vb-design-section mt-12 [scroll-margin-top:24px] [&:first-of-type]:mt-0',
  sectionTitle:
    'vb-design-sectionTitle m-0 text-title font-semibold [letter-spacing:var(--tracking-title)]',
  rule: 'vb-design-rule max-w-[var(--measure)] [margin:4px_0_20px] text-muted-foreground text-small',
  specimen: 'vb-design-specimen mt-6',
  specimenHead: 'vb-design-specimenHead flex items-baseline gap-3 mb-2',
  specimenName: 'vb-design-specimenName m-0 text-small font-semibold',
  specimenNote: 'vb-design-specimenNote text-muted-foreground text-caption',
  islands: 'vb-design-islands grid gap-2',
  island:
    'vb-design-island relative min-w-0 [padding:32px_20px_20px] border border-border [border-radius:var(--radius-lg)] bg-background text-foreground',
  islandLabel:
    'vb-design-islandLabel absolute top-1.5 right-2.5 text-muted-foreground [font-family:var(--font-mono)] text-caption',
  line: 'vb-design-line flex flex-wrap items-center [gap:12px_16px]',
  pile: 'vb-design-pile grid gap-4',
  swatches:
    'vb-design-swatches grid [grid-template-columns:repeat(auto-fill,_minmax(132px,_1fr))] gap-3',
  swatch: 'vb-design-swatch grid gap-1 text-caption',
  chip: 'vb-design-chip h-[36px] border border-border [border-radius:var(--radius-md)]',
  swatchName: 'vb-design-swatchName text-muted-foreground [font-family:var(--font-mono)]',
  swatchUse: 'vb-design-swatchUse text-muted-foreground',
  typeRow:
    'vb-design-typeRow grid [grid-template-columns:150px_minmax(0,_1fr)] gap-4 items-baseline [padding:8px_0] border-b border-b-border last:[border-bottom:0]',
  typeName: 'vb-design-typeName text-muted-foreground [font-family:var(--font-mono)] text-caption',
  spaces: 'vb-design-spaces flex flex-wrap items-end gap-4',
  space:
    'vb-design-space grid [justify-items:center] gap-1 text-muted-foreground [font-family:var(--font-mono)] text-caption',
  spaceBox: 'vb-design-spaceBox bg-primary-soft border border-approval-border',
  radius: 'vb-design-radius w-[56px] h-[36px] border border-border-strong bg-muted',
  fields:
    'vb-design-fields grid [grid-template-columns:repeat(auto-fit,_minmax(240px,_1fr))] gap-4 max-w-[760px]',
  dialogPreview:
    'vb-design-dialogPreview w-[520px] max-w-full overflow-hidden [border-radius:var(--radius-lg)] bg-card [box-shadow:var(--shadow-overlay)]',
  rail: 'vb-design-rail w-[300px] max-w-full',
};

export default styles;
