/**
 * The classes of `now.module.css`, moved to Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). Each entry starts with a marker
 * class (`vb-…`, no style of its own) that the arbitrary variants of the others name.
 */
const styles: Readonly<Record<string, string>> = {
  rowDetail: 'vb-now-rowDetail block mt-0.5 text-muted-foreground text-caption tabular-nums',
  essential: 'vb-now-essential mt-2 [&_>_div_>_button]:block [&_>_div_>_button]:[margin:0_auto]',
  intro: 'vb-now-intro mt-2',
  setupNote: 'vb-now-setupNote [&_a]:text-primary',
  trustRaises: 'vb-now-trustRaises grid gap-2 mt-4',
};

export default styles;
