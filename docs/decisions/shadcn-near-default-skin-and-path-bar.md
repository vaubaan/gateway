---
title: The interface takes a shadcn-near-default skin (slate, sky, denser) and a path bar above the page
status: accepted
date: 2026-10-23
---

# The interface takes a shadcn-near-default skin (slate, sky, denser) and a path bar above the page

> Decided by the product owner on 2026-10-23 after a review of the Settings pages
> and two rounds of mock-ups (nine skins on one screen, then ten screens under four
> layouts). Amends [interface-redesign-vocabulary-and-design-system](interface-redesign-vocabulary-and-design-system.md)
> (the tokens and the shell; the vocabulary, the attention budget and the
> components stand) and the spec [style-guide](../spec/style-guide.md) §1.2, §3,
> §4. Handbook: [web-app](../handbook/web-app.md), "The shell", "Tokens".

## Context

The redesign of 2026-10-13 gave the interface one design system: tokens, the "quiet
control room" stance, a side navigation of seven entries, a local navigation column
for Settings and the Reference, and no top bar. The owner's review found the
density and the words right and the look not: "je ne suis pas convaincu par la
charte graphique. J'aimerais qu'on se recentre sur un shadcn proche du par défaut.
Et on ajoute juste un peu de couleur (light et dark)."

Nine skins of the Missions page, all shadcn-near-default, were drawn; the owner
chose **"Slate + Sky, denser"**: slate neutrals, a sky accent, a 6 px radius, 13 px
text, 36 px rows. Ten screens were then drawn under four layouts that all add a
path in a top bar, which the owner asked for ("j'aime bien avoir un chemin en mode
top bar en plus du side menu"); the owner chose **L4, "two rows"**: the full side
menu, a bar above the page with the path, then the local navigation as a row of
tabs where a page has one, and no local column anywhere.

Two constraints hold from the earlier decision: every documented text-on-surface
pair meets WCAG AA in both themes (the token test enforces it), and the words,
counts and disclosures of the attention budget are untouched.

## Decision

1. **The tokens keep their names and take the chosen values.** `tokens.css` is
   still the one layer of visual decisions and the components read it and nothing
   else: no component is rewritten for the skin. Light: slate neutrals (paper white,
   the navigation and fills on the first slates, hairlines on slate 200 and 300,
   ink on slate 900/800/600, placeholders on slate 400), the accent on sky 700 (sky
   500, shadcn's default, is below AA on white for text and is not used), the
   exceptions on amber 700, red 600 and green 700 with their 50 tints. Dark: the
   slate 950/900/800 surfaces of shadcn's slate theme, ink on slate 50/300/400, the
   accent on sky 400, the exceptions on the 400 shades. Four text sizes become
   11, 12, 13 and 18 px; the three control heights 28, 32 and 36 px; a row 36 px;
   the radii 4, 6 and 8 px. The letters of a mark and the code block are unchanged.
2. **A path bar above the page.** The page column gets a bar at its top, sticky,
   44 px: on the left the **path** — the instance (its mark and its name, leading
   home), the section the page is in, then the page's own crumbs and its title, the
   last one strong and not a link — and on the right the theme toggle and the
   person's menu, which leave the foot of the side navigation. The path is built
   from what the page already declares: `PageHeader` publishes its crumbs and its
   title to the bar (`TrailSetter`), and the bar draws the instance and the section
   from the route until it has them. The page keeps its header: the title is said
   twice, once as a place and once as a heading, which is what a path is for.
3. **The local navigation is a row of tabs under the path, not a column.** Settings
   ("You", then "Administration") and the Reference (every service) render their
   entries as one horizontal row at the top of the page column, sticky under the
   bar, each group's name a quiet word before its entries; the current entry is the
   strong word with a rule under it. `SubNav` and `SubNavFrame` keep their contract
   and change their drawing; no page changes. The row is as wide as the page column,
   not the window: it is rendered by the page frames, on the server, so that nothing
   shifts after hydration — a bar that spans the window would have to be rendered
   by the shell, which does not know the page.
4. **The side navigation keeps its seven entries, its brand and its widths**
   (220 px, 56 px collapsed, the bar of a phone). Its foot is empty: the person and
   the theme are in the path bar. On a phone the path bar is the top row (the
   instance's mark, the path, the theme, the person) and the navigation stays the
   bar at the bottom.
5. **The service marks are the brand icons, monochrome** — decided the same day,
   recorded in [service-icons-declared-by-the-plugin](service-icons-declared-by-the-plugin.md).

## Consequences

- The style guide loses "no top bar" from §1.2 and gains the bar in §4; §3 takes
  the new sizes and the new families of values. The attention budget (§1), the
  words (§2) and the components (§5) are unchanged.
- The e2e shell test keeps its geometry (a 220 px column, 56 px collapsed, a 390 px
  bar on a phone) and gains the bar: the path reads the section and the page, the
  theme toggle and the person are found there, and the local navigation of Settings
  is a row of tabs whose entries are 32 px targets on a phone.
- The token test's list of sizes changes; its contrast pairs hold as they are.
- The gallery (`/design`) shows the tab row as a specimen, both themes; the bar is the shell's own and is seen on every page.
- A later skin is again a change of values in `tokens.css` first.

## Rejected alternatives

- **Adopt shadcn/ui itself (Tailwind, Radix, its component code).** The product
  has its own components, tested by role and by word, and the owner asked for the
  look of shadcn, not its stack. Taking the values keeps the tests, the gallery and
  the tokens as the one source; a library would add a second one.
- **Layout L1 (a path bar and the local column kept), L2 (the bar carries the
  page's primary action), L3 (an icon rail).** L2 separates the one action from
  the sentence that explains it; L3 hides the seven names, which the shell test and
  the first-run page rely on; L1 keeps two forms of local navigation. L4 gives one
  model: global on the left, local under the path.
- **A bar rendered by the shell, as wide as the window, with the tabs published
  by the page after hydration.** It would shift the page down once hydrated on
  every Settings and Reference page; a row as wide as the page column, rendered
  on the server, does not.
- **Sky 500 for the accent, as shadcn ships it.** 2.9:1 on white: links and the
  figure of a meter would fall below AA. Sky 700 keeps the hue and passes.
