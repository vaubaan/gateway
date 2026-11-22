/**
 * The classes of `TokenGuide.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  guide: 'vb-tokenguide-guide flex flex-col gap-8 max-w-[var(--measure)]',
  steps: 'vb-tokenguide-steps m-0 pl-[1.25em] text-muted-foreground text-small [&_li_+_li]:mt-1',
  link: 'vb-tokenguide-link [margin:8px_0] text-small [&_a]:text-primary',
  access: 'vb-tokenguide-access text-muted-foreground text-caption whitespace-nowrap',
  code: 'vb-tokenguide-code mt-2',
  alternatives:
    'vb-tokenguide-alternatives flex flex-wrap [gap:8px_24px] [margin:16px_0] p-0 border-0',
  alternativesLegend:
    'vb-tokenguide-alternativesLegend mb-2 text-foreground text-small font-semibold',
  alternative: 'vb-tokenguide-alternative flex flex-col gap-1 max-w-[22rem]',
  path: 'vb-tokenguide-path flex flex-wrap items-center gap-1 mb-1 text-caption',
  pathItem: 'vb-tokenguide-pathItem inline-flex items-center gap-1',
  pathSegment:
    'vb-tokenguide-pathSegment [padding:0_8px] [border-radius:var(--radius-sm)] bg-approval-border text-foreground font-semibold [line-height:1.6]',
  pathSeparator: 'vb-tokenguide-pathSeparator text-muted-foreground',
  shot: 'vb-tokenguide-shot [margin:8px_0_0] max-w-full [&_img]:block [&_img]:max-w-full [&_img]:h-auto [&_img]:border [&_img]:border-border [&_img]:[border-radius:var(--radius-sm)] [&_figcaption]:mt-1 [&_figcaption]:text-muted-foreground [&_figcaption]:text-caption',
};

export default styles;
