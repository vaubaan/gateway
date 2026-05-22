---
title: Tailwind v4 + @theme inline comme moteur de tokens du style guide
status: accepted
date: 2026-05-22
author: rpelissier
tracks:
  - packages/web/src/app/globals.css
  - packages/web/package.json
---

# Tailwind v4 + `@theme inline` comme moteur de tokens du style guide

## Contexte

La spec `docs/spec/style-guide.md` prescrit un système à 3 étages — primitives → semantic → utilities — où les semantic tokens varient selon le thème (dark/light) sans recompilation. Il faut un moteur capable de :

- Exposer des tokens nommés comme classes utilitaires (`bg-background`, `text-foreground`, `border-border-default`).
- Permettre à ces classes de **résoudre dynamiquement** vers une valeur différente selon un attribut HTML (`[data-theme='dark']`) ou une media query (`prefers-color-scheme: dark`) — sans rebuilder le CSS.
- Rester minimal — pas de runtime JS pour résoudre les tokens, pas de pre-processor lourd.

Le projet utilisait déjà Tailwind v4 dans `packages/web` (`tailwindcss@4.3.0`, `@tailwindcss/postcss`). Cette ADR fige le choix de continuer avec Tailwind v4 plutôt que de migrer vers un autre moteur.

## Décision

On adopte **Tailwind v4 avec le bloc `@theme inline`** comme moteur de tokens unique.

Concrètement, `globals.css` est structuré ainsi :

```css
@import 'tailwindcss';

@layer base {
  :root {
    /* primitives (OKLCH) */
    --gray-0: oklch(0.995 0.002 264);
    /* … */

    /* semantic (light, default) */
    --background: var(--gray-0);
    --foreground: var(--gray-1000);
    /* … */
  }
  :root[data-theme='dark'] {
    --background: var(--gray-1000);
    --foreground: var(--gray-0);
    /* … */
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) {
      /* same overrides */
    }
  }
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  /* … */
}
```

Le mot-clé `inline` est central : il dit à Tailwind v4 de **garder la référence `var(--background)`** dans les utilities générées au lieu d'inliner la valeur compilée. Conséquence : `bg-background` s'écrit `background-color: var(--background)` au runtime, et bascule dark/light sans rebuild.

Pas de tokens écrits en JS, pas de `tailwind.config.ts` (Tailwind v4 lit la config depuis le CSS lui-même via `@theme`).

## Conséquences

### Positives

- **Zero-rebuild theme switching.** Toggle `data-theme` sur `<html>` → toute l'UI bascule. Critique pour le bootstrap anti-FOUC et un futur toggle user.
- **Source de vérité unique.** Les tokens vivent dans un seul fichier (`globals.css`), pas éparpillés entre un `theme.ts` et du CSS.
- **Tooling familier.** L'équipe utilise déjà Tailwind ; pas de courbe d'apprentissage.
- **Bundle léger.** Tailwind v4 ne génère que les classes utilisées (JIT par défaut). Le CSS final reste petit même avec 30+ tokens sémantiques.
- **Bon support OKLCH.** Tailwind v4 sait composer avec `oklch(...)` nativement, y compris dans les utilities générées.

### Négatives / contraintes

- **`@theme inline` est jeune** (Tailwind v4 GA en early 2025). Régressions possibles entre minor releases — il faut surveiller le CHANGELOG.
- **Verbosité du dual-theme.** Le bloc dark est dupliqué deux fois (sous `[data-theme='dark']` et sous `@media (prefers-color-scheme: dark)`). Une refactor avec `@custom-variant` ou similar deviendra utile si le set de tokens triple.
- **Couplage à Tailwind.** Si on devait migrer un jour (vers PandaCSS, vanilla-extract, …), il faudrait porter tout le CSS. Migration possible mais non-triviale (~30 tokens × 2 thèmes).
- **Pas de validation statique** des noms de tokens — `bg-foregruond` (typo) ne fail pas à la compilation, juste à l'inspection visuelle. Atténué par : ESLint `tailwindcss/no-custom-classname` peut être activé en suivi.

## Alternatives rejetées

### PandaCSS

Génère du CSS-in-JS avec un système de tokens first-class et un excellent typing. Refusé parce que :

- Surface API plus large à apprendre / maintenir.
- Stack Tailwind déjà en place — migration coûteuse pour un gain marginal.
- L'avantage typing est moins critique sur un projet ~30 tokens.

### vanilla-extract

CSS-in-TS pur, fully typed. Refusé pour les mêmes raisons que PandaCSS, plus :

- Build step supplémentaire (`vanilla-extract/vite-plugin` ou équivalent Next.js).
- Pas de génération d'utilities ; il faudrait écrire chaque `bg-background` comme une recipe — verbeux.

### CSS pur sans Tailwind

Tokens en custom properties + classes BEM-like écrites à la main. Refusé :

- Perte des utilities Tailwind hors tokens (flex, grid, spacing utilities, etc.) — réécrire tout serait massif.
- Inversion de la convention de l'équipe.

### `@theme` (sans `inline`)

Sans `inline`, Tailwind v4 résout les `var(...)` à la compilation et produit `background-color: oklch(...)` en dur. Aucun theme switching possible sans rebuild. Inutilisable pour notre cas.
