# Style Guide — spec

> **Statut :** spec greenfield draft. Aucun style guide n'existait avant
> ce document. La codebase frontend (`apps/gateway`) accumule des
> conventions Tailwind locales contradictoires — cards blanches sur fond
> noir, palette `neutral-100..950` utilisée en vrac, accents `red-400` /
> `yellow-900` / `green-100` ad-hoc — que cette spec vise à remplacer
> par un vocabulaire visuel cardinal et borné.
>
> **Filiation.** Style calqué sur **Geist**, le design system
> open-source de Vercel ([vercel.com/design](https://vercel.com/design),
> [github.com/vercel/geist-font](https://github.com/vercel/geist-font)).
> Pas une copie pixel-perfect — une adoption de ses tenets (noir-et-blanc
> d'abord, hairline borders, espace généreux, typographie sobre,
> micro-motion).

## 0. Vocabulaire

7 mots, distincts et non-interchangeables :

- **Token** — variable nommée porteuse d'une décision visuelle (ex.
  `surface-base`, `border-subtle`, `text-muted`). Les tokens sont la
  seule source de vérité ; aucun composant ne référence une valeur
  brute (`oklch(…)`, `#…`, `12px`).
- **Primitive token** — l'étage le plus bas : une couleur, une taille,
  une durée. Ex. `gray-0` à `gray-1000`, `space-1` à `space-12`,
  `radius-sm`. Anonyme sémantiquement (`gray-200` ne dit pas *à quoi
  ça sert*).
- **Semantic token** — l'étage qui *prescrit l'usage* : `surface-base`,
  `surface-raised`, `text-foreground`, `text-muted`, `border-subtle`,
  `accent-info`, `accent-success`, `accent-warning`, `accent-danger`.
  Pointe vers un primitive token qui change selon le thème (dark/light).
- **Component primitive** — composant UI atomique partagé : Button,
  Input, Card, Badge, Table, Dialog, Banner. Construit uniquement à
  partir de semantic tokens. Aucun écran ne re-implémente un bouton.
- **Surface** — un plan visuel (fond + bord). Trois niveaux cardinaux :
  *base* (la page elle-même), *raised* (cards, panneaux), *overlay*
  (dialogs, popovers — au-dessus du flow).
- **Hairline** — un bord de 1px qui se distingue *uniquement* par sa
  luminance. Préféré aux ombres portées comme séparateur visuel.
- **Density** — degré de compacité d'un layout. Trois presets :
  *comfortable* (formulaires, onboarding), *default* (la majorité des
  écrans), *compact* (tables, listes denses).

## 1. Vision

Le **Style Guide** est le sous-système non-fonctionnel qui :

1. **Définit** un vocabulaire visuel cardinal (couleurs, typographie,
   espacement, rayons, motion, ombres) sous forme de tokens nommés.
2. **Garantit** une cohérence visuelle entre tous les écrans du produit,
   en interdisant aux composants de référencer des valeurs brutes.
3. **Supporte nativement** deux modes : *dark* (défaut produit) et
   *light* (parité visuelle stricte, même hiérarchie typo, mêmes
   composants, mêmes states).
4. **Fournit** un set borné de component primitives partagés (Button,
   Input, Card, Badge, Table, Dialog, Banner) qu'aucun écran ne
   re-implémente localement.
5. **S'inspire** de Geist (Vercel) dans ses tenets : noir-et-blanc
   d'abord, accents sémantiques sparse, hairline borders au lieu
   d'ombres marquées, typographie Geist Sans + Geist Mono, motion
   ≤ 200ms ease-out.

### 1.1 Hors-scope explicite

- **Aucune** customisation de thème par utilisateur ou par organization
  (pas de "brand color picker"). Le style est uniforme produit-wide.
- **Aucun** preset de density globale ("compact mode" / "comfortable
  mode" toggle user). La density est choisie *par composant*, pas par
  préférence user.
- **Aucun** système d'illustrations ou de mascots. Les icônes sont des
  glyphes neutres (set unique à ADRifier).
- **Aucune** bibliothèque de motion / animations chorégraphiées. Le
  motion se limite à des transitions atomiques (hover, focus, expand)
  de durée ≤ 250ms.
- **Aucune** synchronisation avec un outil de design (Figma, Sketch).
  La source de vérité est le code, pas un fichier `.fig`.
- **Aucune** redéfinition libre de tokens par composant. Si un besoin
  visuel n'a pas de token, on en ajoute un — on ne dévie pas localement.
- **Aucun** thème "high contrast" séparé en v1 (les ratios AA suffisent).

## 2. Domaine

### 2.1 Hiérarchie des tokens

```
Primitive tokens         (anonymes, sans usage prescrit)
   │
   ├── color/gray         (gray-0 .. gray-1000, 12 paliers OKLCH)
   ├── color/blue         (info)
   ├── color/green        (success)
   ├── color/amber        (warning)
   ├── color/red          (danger)
   ├── space              (space-0 .. space-24, base 4px)
   ├── radius             (none | xs | sm | md | lg | full)
   ├── font-size          (text-xs .. text-3xl)
   ├── font-weight        (regular | medium | semibold | bold)
   ├── duration           (fast=100ms | base=150ms | slow=250ms)
   └── shadow             (none | sm | md)
        │
        ▼
Semantic tokens          (prescrivent l'usage, varient dark/light)
   │
   ├── surface-base       (le fond de page)
   ├── surface-raised     (cards, panneaux)
   ├── surface-overlay    (dialogs, popovers)
   ├── surface-sunken     (zones inset : code blocks, preformatted)
   ├── text-foreground    (texte principal)
   ├── text-muted         (texte secondaire)
   ├── text-subtle        (placeholders, labels désactivés)
   ├── text-inverse       (texte sur fond inverse : bouton primaire)
   ├── border-subtle      (hairline défaut)
   ├── border-strong      (hairline marqué : focus, hover sur input)
   ├── accent-info        (informationnel — bleu)
   ├── accent-success     (vert)
   ├── accent-warning     (amber)
   ├── accent-danger      (rouge)
   └── focus-ring         (anneau focus accessible, distinct des accents)
        │
        ▼
Component primitives     (Button, Input, Card, …)
   └── ne consomment QUE des semantic tokens
```

### 2.2 Palette

**Neutre — gray scale OKLCH.** 12 paliers de `gray-0` (presque blanc) à
`gray-1000` (presque noir), espacés perceptuellement (OKLCH lightness).
Le mode *dark* mappe `surface-base → gray-980`, *light* mappe
`surface-base → gray-20`. Les valeurs exactes vivent dans le handbook.

**Accents.** Quatre familles, chacune en 4 paliers (`-50` / `-200` /
`-600` / `-900`). Usage cardinal :

| Famille | Usage | Dark : fond / texte | Light : fond / texte |
|---|---|---|---|
| `blue` (info) | banner informationnel, lien actif | `blue-900` / `blue-200` | `blue-50` / `blue-900` |
| `green` (success) | resource healthy, opération réussie | `green-900` / `green-200` | `green-50` / `green-900` |
| `amber` (warning) | reseal requis, statut dégradé | `amber-900` / `amber-200` | `amber-50` / `amber-900` |
| `red` (danger) | erreur 4xx/5xx, action destructive | `red-900` / `red-200` | `red-50` / `red-900` |

Aucun composant ne référence directement `blue-600` ; il référence
`accent-info` qui *résout* vers le bon palier selon mode et contexte.

### 2.3 Typographie

| Token | Famille | Usage |
|---|---|---|
| `font-sans` | **Geist Sans** | tout le texte UI (paragraphes, labels, boutons, headings) |
| `font-mono` | **Geist Mono** | identifiants techniques (provider_ref, slugs, JSON, code) |

Échelle : `text-xs` (11px) · `text-sm` (13px) · `text-base` (14px) ·
`text-md` (15px) · `text-lg` (17px) · `text-xl` (20px) · `text-2xl`
(24px) · `text-3xl` (32px). Aucun composant n'utilise une taille hors
échelle.

**Pas plus de 3 tailles distinctes par écran.** Hiérarchie typique :
title (`text-xl` semibold) → body (`text-sm` regular) → meta (`text-xs`
muted). Le contraste vient du *weight* et de la *couleur*, pas
uniquement de la taille.

### 2.4 Espacement

Échelle multiplicative sur base 4px : `space-1` (4) · `space-2` (8) ·
`space-3` (12) · `space-4` (16) · `space-6` (24) · `space-8` (32) ·
`space-12` (48) · `space-16` (64) · `space-24` (96).

Densités cardinales :

| Density | Padding card | Gap form-fields | Cas d'usage |
|---|---|---|---|
| *comfortable* | `space-6` | `space-4` | onboarding, dialogs, single-form |
| *default* | `space-4` | `space-3` | la majorité des écrans applicatifs |
| *compact* | `space-2` | `space-1` | tables, listes denses, sidebar items |

### 2.5 Rayons et bords

| Token | Valeur | Usage |
|---|---|---|
| `radius-none` | 0 | tables pleine largeur, sections inset |
| `radius-xs` | 2px | inputs inline, badges étroits |
| `radius-sm` | 4px | boutons, inputs, badges |
| `radius-md` | 6px | cards, panneaux raised |
| `radius-lg` | 8px | dialogs, modales |
| `radius-full` | 999px | pills (status badges arrondis), avatars |

**Bords > ombres.** Un hairline 1px en `border-subtle` est *toujours*
préféré à `shadow-sm`. Les ombres ne sont autorisées que sur les
surfaces *overlay* (dialogs flottants, popovers détachés du flow).

### 2.6 Motion

3 durées seulement : `duration-fast` (100ms), `duration-base` (150ms),
`duration-slow` (250ms). Easing par défaut : `ease-out`. Pas de bounce,
pas de spring. Les transitions ciblent uniquement : `background-color`,
`border-color`, `color`, `opacity`, `transform`. **Jamais** de
transition sur `height` ou `width` (préférer `max-height` ou un swap
d'état discret).

### 2.7 État de focus

`focus-ring` est un anneau **distinct** des accents sémantiques —
typiquement `blue-500` à 2px d'offset, visible sur tous les fonds. Le
focus n'est jamais supprimé visuellement, seulement remplacé (jamais
`outline: none` sans alternative).

## 3. Format / Layout

### 3.1 Où vivent les tokens

Les tokens vivent dans **une seule feuille de style racine** chargée
par l'application. Ils sont exposés comme custom properties CSS
résolues par le runtime (pas de pré-compilation par composant). Le
toggle dark/light bascule un *attribut sur la racine du document* —
aucun composant ne re-déclare ses couleurs en fonction du thème.

### 3.2 Component primitives — v1

Set minimal partagé par tous les écrans, dans l'ordre de priorité :

1. **Button** — variants : `primary`, `secondary`, `ghost`, `danger`,
   `link`. Tailles : `sm`, `md`. États : default, hover, active,
   focus, disabled, loading.
2. **Input** — `text`, `password`, `textarea`. États : default, focus,
   error, disabled. Pas de "success state" (l'absence d'erreur suffit).
3. **Card** — wrapper surface-raised + hairline. Optionnel : header,
   footer.
4. **Badge** — `neutral`, `info`, `success`, `warning`, `danger`.
   Tailles : `sm`, `md`. Forme : pill (`radius-full`) ou rectangle
   (`radius-sm`).
5. **Table** — header sticky optionnel, hairline entre rangées,
   density configurable, sort affordances cohérentes.
6. **Dialog** — overlay sombre + surface-overlay centrée, focus trap,
   ESC pour fermer, motion `duration-base`.
7. **Banner** — `info`, `warning`, `danger`. Pleine largeur (typiquement
   en haut d'un layout), dismissible optionnel.

### 3.3 Hors v1 (deferred)

- **Tooltip** (utile mais non bloquant — v1.1).
- **DropdownMenu** (la nav actuelle utilise des links, suffisant pour v1).
- **Tabs** (aucun écran v1 ne nécessite des onglets).
- **Toast / Snackbar** (les erreurs sont affichées inline pour l'instant).

## 4. Composition

### 4.1 Avec les features

Chaque feature module consomme **uniquement** :
- les semantic tokens (jamais primitive directement),
- les component primitives (jamais une re-implémentation locale).

Si un écran a besoin d'un visuel non couvert, la séquence est :
1. mention dans la doc,
2. enrichissement du style guide (cette spec + handbook),
3. *puis* implémentation de l'écran.

Pas de "je passe en dur cette fois, on factorisera plus tard". Le
style guide est greenfield — c'est le moment de poser la règle.

### 4.2 Avec les ADRs

Décisions techniques liées à ce style guide qui méritent leur propre
ADR (`docs/decisions/<slug>.md`) :

- *Choix du moteur de tokens* — implicite aujourd'hui, mérite ADR
  explicite.
- *Choix de la bibliothèque d'icônes* (lucide / phosphor / SF / custom).
- *Choix de l'embarquement Geist* (self-hosted woff2 / package npm
  Vercel / Google Fonts).
- *Choix d'une lib de component primitives* (headless + recipe maison /
  copy-paste / from-scratch).
- *Stratégie de bascule dark/light* (auto via `prefers-color-scheme` /
  toggle user persisté / combinaison).

## 5. Accessibilité

Contraintes cardinales :

- **Contraste AA minimum** entre `text-foreground` et `surface-base`,
  les deux modes (dark + light). Pour `text-muted`, contraste AA-large
  acceptable mais pas en-dessous.
- **Focus toujours visible.** `focus-ring` ne peut être supprimé que
  remplacé.
- **Pas de couleur seule** pour véhiculer un statut. Toujours
  couleur + icône + label texte. Un badge "success" porte son label.
- **Motion respecte `prefers-reduced-motion`.** Si activé, les
  transitions tombent à 0ms (mais l'état final reste identique).
- **Targets tactiles ≥ 32px** pour tout élément cliquable, même en
  density compact.

## 6. Tests

Le style guide se teste à **deux niveaux** :

- **Visual regression** sur un *page gallery* qui rend chaque
  component primitive dans chaque variant × état × thème. Toute
  modification de token devient visible sur les diffs.
- **Contrast probe** automatisée : un test parcourt les paires
  `text-*` × `surface-*` et vérifie le ratio AA dans les deux modes.
  Échoue si une combinaison documentée tombe sous le seuil.

Pas de test "ce bouton est bleu" — les tokens sont la spec, le test
vérifie les *propriétés émergentes* (contraste, présence du focus
ring, respect du `prefers-reduced-motion`).

## 7. Décisions v1 & open questions

### 7.1 Décisions actées

- **Dual theme dark + light** dès la v1, parité stricte.
- **Geist Sans + Geist Mono bundled** (pas de fallback system-only).
- **4 statuts sémantiques** : info / success / warning / danger.
- **OKLCH** comme color model primaire (déjà en place dans
  `globals.css`).
- **Hairline > shadow** comme convention de séparation.

### 7.2 Open questions (à ADRifier)

- **Self-hosted Geist vs package npm Vercel vs Google Fonts** — coût
  bundle vs simplicité de maj.
- **Icon set** — lucide est le candidat naturel (mêmes choix
  esthétiques que Geist), mais pas tranché.
- **Stratégie de base de component primitives** — headless +
  styles maison ? copy-paste ? from-scratch ?
- **Bascule dark/light** — automatique (`prefers-color-scheme`) ou
  toggle user persisté ?
- **Composantes deferred (Tooltip, Dropdown, Tabs, Toast)** — date /
  trigger de v1.1 ?
