---
title: Component primitives écrits from-scratch (pas de radix / shadcn)
status: accepted
date: 2026-05-22
author: rpelissier
tracks:
  - packages/web/src/components/ui/button.tsx
  - packages/web/src/components/ui/input.tsx
  - packages/web/src/components/ui/card.tsx
  - packages/web/src/components/ui/badge.tsx
  - packages/web/src/components/ui/table.tsx
  - packages/web/src/components/ui/dialog.tsx
  - packages/web/src/components/ui/banner.tsx
  - packages/web/src/components/ui/cn.ts
  - packages/web/src/components/ui/index.ts
---

# Component primitives écrits from-scratch (pas de radix / shadcn)

## Contexte

La spec `docs/spec/style-guide.md` §3.2 prescrit un set de 7 component primitives en v1 : `Button`, `Input`, `Card`, `Badge`, `Table`, `Dialog`, `Banner`. La spec §7.2 liste comme open question la _stratégie_ d'implémentation :

- **Headless lib + recipes maison** : `@radix-ui/react-*` (headless, accessibility-first) + styles Tailwind à nous.
- **Copy-paste recipes** : `shadcn` (composants pré-écrits, tu copies dans ton repo, tu modifies).
- **From-scratch** : écrire les 7 primitives directement, sans lib.

Contraintes :

- Surface fonctionnelle v1 modeste : 7 primitives, variants simples.
- Aucune dépendance frontend lourde déjà en place (pas de `@radix-ui`, pas de `class-variance-authority`).
- Le projet vise la sobriété de dépendances (cf. `packages/web/package.json` ; 7 deps runtime seulement).

## Décision

On écrit les 7 primitives **from-scratch**, sans dépendance externe au-delà de React.

Conventions adoptées :

- **Pas de `class-variance-authority` / `tailwind-variants`** ; les variants sont déclarés comme `Record<VariantName, string>` en haut du fichier (cf. `button.tsx`, `badge.tsx`).
- **Helper `cn`** maison de 3 lignes (`packages/web/src/components/ui/cn.ts`) pour la concat de classNames conditionnels — pas de `clsx`, pas de `classnames`.
- **`forwardRef`** systématique sur les primitives qui acceptent un ref natif (`Button`, `Input`, `Textarea`).
- **Native `<dialog>` pour `Dialog`** — focus trap + ESC + backdrop pseudo gratuits via le navigateur. Pas de portal manuel.
- **React Context pour la `density` de `Table`** — propagation aux cellules sans prop-drilling.
- **Pas de "compose-with-Slot" pattern** (que radix expose). Si on en a besoin un jour, on l'ajoutera.

L'ensemble fait ~350 lignes de TSX total (hors barrel `index.ts`).

## Conséquences

### Positives

- **Zéro nouvelle dépendance.** `package.json` reste maigre, `npm audit` reste léger.
- **Bundle minimal.** Aucun JS de runtime headless lib n'est chargé. Le `Button` exporté pèse littéralement `~80 lignes` côté source.
- **Contrôle total.** L'API des primitives est ce qu'on veut qu'elle soit, pas un compromis avec un mainteneur upstream. On peut breaker l'API sans coordination externe.
- **Apprentissage explicite.** Le code est lisible par n'importe qui qui sait React — pas de pattern obscur "asChild" / "Slot" / compound-components-avec-context-magique.
- **Pas de lock-in.** Si on veut migrer vers radix plus tard pour une fonctionnalité spécifique (ex. `Tooltip` avec positionnement smart), on importe radix juste pour ce composant — pas tout le set.

### Négatives / contraintes

- **Accessibilité à porter nous-mêmes.** Radix donne des focus traps, des ARIA descriptions correctes, des keyboard nav gratuits. Sans lui, on doit y penser à chaque composant.
  - `Dialog` est OK parce qu'on délègue au `<dialog>` natif (focus trap + ESC inclus).
  - `Button`, `Input`, `Badge`, `Banner`, `Card`, `Table` sont des éléments sémantiques natifs — peu de risque.
  - **Risque réel** : les futurs `Tooltip`, `DropdownMenu`, `Combobox` (deferred en v1.1) sont durs à écrire à la main. Si on en a besoin, on évalue radix à ce moment-là.
- **Pas de "design system marketplace".** shadcn donne accès à 50+ composants pré-stylés ; from-scratch demande d'écrire chacun. Acceptable parce que la surface v1 est petite.
- **Pas de feature flags / theming hooks** pré-construits. Quand on en aura besoin, à écrire.

## Alternatives rejetées

### `shadcn` (copy-paste)

Cloner les 7 primitives depuis `ui.shadcn.com` et adapter à nos tokens.

Avantages : démarrage plus rapide, accessibilité déjà câblée (shadcn = radix sous le capot).

Refusé parce que :

- Tire `@radix-ui/react-dialog`, `@radix-ui/react-slot`, `class-variance-authority`, `clsx`, `tailwind-merge` — 5 deps pour des primitives qu'on a écrites en 350 lignes.
- L'API shadcn est conçue pour des projets plus larges (compound components, asChild prop, …) — overkill pour notre surface.
- Le "copy" implique qu'on devient mainteneur du code de toute façon — autant l'écrire à notre forme.

### `@radix-ui/react-*` headless + recipes maison

Importer chaque primitive radix (sans shadcn) et la styler nous-mêmes.

Avantages : a11y top, focus management top.

Refusé parce que :

- Surface bundle (`@radix-ui/react-dialog` à lui seul = ~20 KB gzip + deps).
- Notre v1 n'a pas besoin des features avancées de radix (portal config, controlled state composé, slot composition).
- Quand on aura besoin (Tooltip, Dropdown, Combobox v1.1), on importera radix _uniquement_ pour ces composants. Pas tout.

### Material UI / Mantine / Chakra

Stack complètes "batteries-included". Refusé immédiatement :

- Esthétique éloignée de Geist/Vercel-like (formes plus arrondies, ombres marquées).
- Bundle massif (50-200 KB).
- Theme tokens conflictants avec notre système OKLCH.
