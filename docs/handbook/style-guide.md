---
title: Style guide — implémentation
tracks:
  - packages/web/src/app/globals.css
  - packages/web/src/app/layout.tsx
  - packages/web/src/components/ui/cn.ts
  - packages/web/src/components/ui/button.tsx
  - packages/web/src/components/ui/input.tsx
  - packages/web/src/components/ui/card.tsx
  - packages/web/src/components/ui/badge.tsx
  - packages/web/src/components/ui/table.tsx
  - packages/web/src/components/ui/dialog.tsx
  - packages/web/src/components/ui/banner.tsx
  - packages/web/src/components/ui/index.ts
  - packages/web/package.json
---

# Style guide — implémentation

> Handbook qui documente _comment_ le style guide est implémenté sur la stack en place (Next.js 15 + Tailwind v4 + React 19). La _vision_ — vocabulaire visuel, hors-scope, contraintes a11y — vit dans `docs/spec/style-guide.md` ; lis-la avant ce document.

## 0. Vue d'ensemble

```
packages/web/src/
├── app/
│   ├── globals.css          # source unique des tokens + base styles
│   └── layout.tsx           # Geist Sans/Mono binding + bootstrap data-theme
└── components/ui/
    ├── cn.ts                # helper d'assemblage de className
    ├── button.tsx           # primitive : Button
    ├── input.tsx            # primitive : Input, Textarea
    ├── card.tsx             # primitive : Card + sub-components
    ├── badge.tsx            # primitive : Badge
    ├── table.tsx            # primitive : Table + sub-components (client)
    ├── dialog.tsx           # primitive : Dialog + sub-components (client)
    ├── banner.tsx           # primitive : Banner
    └── index.ts             # barrel export — import par défaut depuis '@/components/ui'
```

## 1. Le système de tokens (`globals.css`)

### 1.1 Trois couches

```
@layer base {
  :root { … primitive tokens (--gray-*, --blue-*, …) … }
  :root { … semantic tokens light (--background, --foreground, …) … }
  :root[data-theme='dark'] { … semantic tokens dark override … }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) { … semantic tokens dark override … }
  }
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  …
}

/* base element rules (body, :focus-visible, prefers-reduced-motion) */
```

- **Couche 1 — primitives** (`--gray-0..1000`, `--blue-{50,200,500,600,900}`, …) : valeurs OKLCH, anonymes. Définies une seule fois sur `:root`, ne changent jamais selon le thème.
- **Couche 2 — semantic** (`--background`, `--foreground`, `--surface`, `--muted`, `--border-default`, `--info`, …) : pointent vers des primitives, **changent selon le thème**.
- **Couche 3 — utilities Tailwind** : le bloc `@theme inline` expose les semantic tokens comme classes utilitaires (`bg-background`, `text-foreground`, `border-border-default`, `bg-info`, etc.). Le mot-clé `inline` est essentiel : il dit à Tailwind v4 de garder la référence `var(...)` au runtime au lieu d'inliner la valeur compilée — sans ça, le toggle dark/light demanderait une recompilation.

### 1.2 Pourquoi OKLCH

OKLCH est perceptuellement uniforme : un écart de `0.1` sur la lightness produit un écart visuel constant, quel que soit la teinte. Conséquence : la gray scale 12 paliers reste lisible aussi bien en clair qu'en sombre, et les accents (`blue`/`green`/`amber`/`red`) ont des poids visuels comparables à lightness égale.

Format : `oklch(L C H)` avec L ∈ [0,1], C la chroma, H ∈ [0,360].

### 1.3 La table des semantic tokens

| Token                                                     | Light (default)                        | Dark                                   | Usage                                                                    |
| --------------------------------------------------------- | -------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `--background`                                            | `gray-0`                               | `gray-1000`                            | fond de page                                                             |
| `--foreground`                                            | `gray-1000`                            | `gray-0`                               | texte principal                                                          |
| `--surface`                                               | `white`                                | `gray-950`                             | cards, panneaux raised                                                   |
| `--surface-foreground`                                    | `gray-1000`                            | `gray-0`                               | texte sur surface                                                        |
| `--overlay`                                               | `white`                                | `gray-900`                             | dialogs, popovers                                                        |
| `--overlay-foreground`                                    | `gray-1000`                            | `gray-0`                               | texte sur overlay                                                        |
| `--sunken`                                                | `gray-100`                             | `gray-1000`                            | zones inset, hover de table row                                          |
| `--muted`                                                 | `gray-500`                             | `gray-400`                             | texte secondaire                                                         |
| `--subtle`                                                | `gray-400`                             | `gray-600`                             | placeholders, désactivé                                                  |
| `--primary`                                               | `gray-1000`                            | `gray-0`                               | fond de bouton primaire (inverse du background)                          |
| `--primary-foreground`                                    | `gray-0`                               | `gray-1000`                            | texte sur bouton primaire                                                |
| `--border-default`                                        | `gray-200`                             | `gray-800`                             | hairline défaut                                                          |
| `--border-strong`                                         | `gray-400`                             | `gray-700`                             | hairline marqué                                                          |
| `--info` / `--info-foreground` / `--info-border`          | `blue-50` / `blue-900` / `blue-200`    | `blue-900` / `blue-200` / dark blue    | accent info                                                              |
| `--success` / `--success-foreground` / `--success-border` | `green-50` / `green-900` / `green-200` | `green-900` / `green-200` / dark green | accent success                                                           |
| `--warning` / `--warning-foreground` / `--warning-border` | `amber-50` / `amber-900` / `amber-200` | `amber-900` / `amber-200` / dark amber | accent warning                                                           |
| `--danger` / `--danger-foreground` / `--danger-border`    | `red-50` / `red-900` / `red-200`       | `red-900` / `red-200` / dark red       | accent danger                                                            |
| `--ring`                                                  | `blue-500`                             | `blue-500`                             | anneau focus (identique dark/light, suffisamment contrasté sur les deux) |

### 1.4 Utilities Tailwind correspondantes

Chaque token `--background`, `--foreground`, etc. est exposé via `@theme inline` comme `--color-background`, `--color-foreground`, etc. Tailwind v4 génère les utilities :

- `bg-background`, `text-foreground`, `border-border-default`
- `bg-surface`, `text-surface-foreground`
- `bg-overlay`, `text-overlay-foreground`
- `bg-sunken`, `text-muted`, `text-subtle`
- `bg-primary`, `text-primary-foreground`
- `bg-info`, `text-info-foreground`, `border-info-border`
- (idem `success`, `warning`, `danger`)
- `outline-ring`, `focus-visible:outline-ring`

**Règle absolue dans le code applicatif :** n'utilise QUE ces classes. Jamais `bg-neutral-950`, jamais `text-red-600`, jamais une valeur `oklch(...)` ou `#xxx` en inline.

## 2. Typographie — Geist via `geist` npm

### 2.1 Pourquoi le package npm

Trois options :

1. **`geist` npm package** (publié par Vercel) — wrapper next/font ; auto-hosting via Next.js, optimisé, exposé en CSS variable.
2. **Self-hosted woff2** — télécharger les fichiers depuis `vercel/geist-font` et les servir.
3. **Google Fonts** — Geist y est disponible mais via CDN externe.

On a choisi (1) parce que :

- Auto-hosting sans config manuelle (next/font copie les fichiers dans `.next/` au build).
- Pas de FOIT (next/font préload + font-display swap).
- Maj transparente avec `npm update geist`.
- Pas de CDN tiers (Google Fonts) qui aurait ajouté une dépendance réseau au time-to-first-paint et une fuite RGPD potentielle.

Voir `docs/decisions/geist-via-vercel-npm-package.md`.

### 2.2 Binding

```tsx
// app/layout.tsx
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

<html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
```

Chaque object exporte `.variable` qui est une string genre `__variable_xxx`. Appliquée sur `<html>`, elle injecte la custom property `--font-geist-sans` (resp. `--font-geist-mono`) dans la cascade.

Dans `globals.css`, on s'en sert :

```css
@theme inline {
  --font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

Les fallbacks system-ui restent en place au cas où le bundle ne charge pas.

### 2.3 Échelle

L'échelle (`text-xs`, `text-sm`, `text-base`, `text-md`, `text-lg`, `text-xl`, `text-2xl`, `text-3xl`) reste celle de Tailwind v4 par défaut. La spec demande "pas plus de 3 tailles distinctes par écran" — convention humaine, pas enforced par le code.

## 3. Sélection du thème (dark / light)

### 3.1 Trois sources, par ordre de priorité

1. **`<html data-theme="dark">` ou `<html data-theme="light">`** — override explicite (utilisé par le bootstrap quand l'utilisateur a choisi via localStorage).
2. **`prefers-color-scheme: dark`** — auto OS, appliqué seulement si pas d'override.
3. **Default** — light (les semantic tokens light sont les valeurs initiales sur `:root`).

### 3.2 Le bootstrap anti-FOUC

Le `<script>` inline dans `<head>` lit `localStorage['crm.theme']` AVANT le premier paint et applique l'attribut `data-theme` si nécessaire. Sans ce script, on aurait un flash dark→light (ou vice-versa) à l'hydratation.

```tsx
// app/layout.tsx
const themeBootstrap = `(function(){try{var t=localStorage.getItem('crm.theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(_){}})();`;

<head>
  <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
</head>;
```

C'est `dangerouslySetInnerHTML` parce que Next.js sinon escape le contenu. Pas un risque XSS — la string est littérale et n'interpole aucune valeur user.

### 3.3 Toggle utilisateur

**Pas d'UI de toggle en v1.** Pour basculer le thème en dev/staging :

```js
localStorage.setItem('crm.theme', 'dark');
location.reload();
localStorage.setItem('crm.theme', 'light');
location.reload();
localStorage.removeItem('crm.theme');
location.reload(); // retour à prefers-color-scheme
```

La spec §7.2 (open questions) prévoit un toggle UI ultérieur. Quand on l'ajoutera, l'helper consommera le même `localStorage['crm.theme']` ; aucun changement CSS nécessaire.

## 4. Les 7 component primitives

Tous sont sous `packages/web/src/components/ui/` et exportés depuis `index.ts`. Convention d'usage :

```tsx
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
```

### 4.1 `Button`

| Prop        | Type                                                        | Default       | Notes                                              |
| ----------- | ----------------------------------------------------------- | ------------- | -------------------------------------------------- |
| `variant`   | `'primary' \| 'secondary' \| 'ghost' \| 'danger' \| 'link'` | `'secondary'` |                                                    |
| `size`      | `'sm' \| 'md'`                                              | `'md'`        |                                                    |
| `loading`   | `boolean`                                                   | `false`       | affiche un spinner + force `disabled`              |
| `className` | `string`                                                    | —             | merge ; utiliser pour `w-full`, `self-start`, etc. |
| `...rest`   | `ButtonHTMLAttributes`                                      | —             | tout le reste (onClick, disabled, type, …)         |

Combinaisons usuelles :

- CTA principal d'un écran → `variant="primary"`
- Bouton dans une toolbar → `variant="secondary"`
- Bouton dans une cellule de table → `variant="ghost" size="sm"`
- Suppression / révocation → `variant="danger"`
- Link inline qui doit ressembler à un bouton → `variant="link"`

### 4.2 `Input`, `Textarea`

| Prop      | Type                                             | Notes                                            |
| --------- | ------------------------------------------------ | ------------------------------------------------ |
| `error`   | `boolean`                                        | rend le border en danger + ajoute `aria-invalid` |
| `...rest` | `InputHTMLAttributes` / `TextareaHTMLAttributes` | tout le reste                                    |

Pas de `success` state — l'absence d'erreur suffit (cf. spec §3.2).

### 4.3 `Card`

`<Card>` est juste le wrapper. Les sous-composants `<CardHeader>` (avec `<CardTitle>` + `<CardDescription>`), `<CardBody>`, `<CardFooter>` sont optionnels — utilise ce dont tu as besoin.

### 4.4 `Badge`

| Prop      | Type                                                        | Default     |
| --------- | ----------------------------------------------------------- | ----------- |
| `variant` | `'neutral' \| 'info' \| 'success' \| 'warning' \| 'danger'` | `'neutral'` |
| `size`    | `'sm' \| 'md'`                                              | `'md'`      |
| `shape`   | `'pill' \| 'square'`                                        | `'pill'`    |

### 4.5 `Table`

Le composant est `'use client'` parce qu'il utilise un React Context pour propager la `density` aux cellules sans que tu aies à la passer à chaque `<TH>` / `<TD>`. Si tu render une table dans un Server Component, importe-la quand même — Next.js fera l'island automatiquement.

```tsx
<Table density="compact">
  <THead>
    <TR>
      <TH>Name</TH>
      <TH>Status</TH>
    </TR>
  </THead>
  <TBody>
    <TR>
      <TD>foo</TD>
      <TD>active</TD>
    </TR>
  </TBody>
</Table>
```

### 4.6 `Dialog`

Wraps le natif `<dialog>` du navigateur — focus trap + ESC pour fermer arrivent gratuitement.

```tsx
const [open, setOpen] = useState(false);

<Dialog open={open} onClose={() => setOpen(false)} ariaLabel="Add access">
  <DialogHeader>
    <DialogTitle>Add access</DialogTitle>
  </DialogHeader>
  <DialogBody>…</DialogBody>
  <DialogFooter>
    <Button variant="ghost" onClick={() => setOpen(false)}>
      Cancel
    </Button>
    <Button variant="primary">Save</Button>
  </DialogFooter>
</Dialog>;
```

L'event `cancel` (déclenché par ESC) est intercepté pour appeler `onClose` au lieu de fermer brutalement le `<dialog>`. Click sur le backdrop appelle aussi `onClose` (désactivable via `dismissOnBackdropClick={false}`).

### 4.7 `Banner`

| Prop        | Type                                           | Default  | Notes                                             |
| ----------- | ---------------------------------------------- | -------- | ------------------------------------------------- |
| `variant`   | `'info' \| 'warning' \| 'danger' \| 'success'` | `'info'` |                                                   |
| `icon`      | `ReactNode`                                    | —        | rendu à gauche                                    |
| `action`    | `ReactNode`                                    | —        | rendu à droite (typiquement un Button)            |
| `onDismiss` | `() => void`                                   | —        | si fourni, affiche un `×` qui appelle ce callback |

`role` est calculé : `'alert'` pour `danger`, `'status'` sinon.

## 5. Ajouter un nouveau token

Cas typique : un écran a besoin d'une couleur d'attention qui n'existe pas, mettons un "feature flag enabled" en violet.

1. **Ouvre `globals.css`** et ajoute la palette violet en primitive :
   ```css
   --purple-50: oklch(0.97 0.03 295);
   --purple-200: oklch(0.86 0.12 295);
   --purple-900: oklch(0.3 0.12 295);
   ```
2. **Ajoute le semantic token** sur `:root` (light) ET sur `:root[data-theme='dark']` ET dans le `@media (prefers-color-scheme: dark)` :
   ```css
   --feature: var(--purple-50);
   --feature-foreground: var(--purple-900);
   --feature-border: var(--purple-200);
   /* dark : */
   --feature: var(--purple-900);
   --feature-foreground: var(--purple-200);
   --feature-border: oklch(0.4 0.12 295);
   ```
3. **Expose-le dans `@theme inline`** :
   ```css
   --color-feature: var(--feature);
   --color-feature-foreground: var(--feature-foreground);
   --color-feature-border: var(--feature-border);
   ```
4. **Mets à jour la spec** (`docs/spec/style-guide.md` §2.2 et §0 si nouveau vocabulaire) ET ce handbook (§1.3).
5. **Utilise** : `bg-feature text-feature-foreground border border-feature-border`.

## 6. Ajouter un nouveau component primitive

Cas typique : on a besoin d'un `Tooltip` (deferred en v1.1).

1. **Crée `packages/web/src/components/ui/tooltip.tsx`**.
2. **Consomme uniquement des semantic tokens** (`bg-overlay`, `text-overlay-foreground`, `border-border-default`, `text-xs`). Pas de `bg-neutral-...`.
3. **Variants en `Record<Name, string>`** comme `VARIANT` dans `button.tsx` — pas de `cva`/`tv` lib externe en v1.
4. **`forwardRef` si l'élément peut recevoir une ref** (pattern de `Button`, `Input`).
5. **Ajoute l'export dans `index.ts`**.
6. **Mets à jour la spec §3.2 / §3.3** si le composant sort de "deferred".
7. **Écris un test** sous `packages/web/tests/unit/components/tooltip.test.tsx`.

## 7. Conventions et pièges

### 7.1 Hairline > shadow

La spec §2.5 et §3.1 prescrivent les hairlines (1px border en `border-border-default`) au lieu d'ombres. Concrètement :

- Cards : `<Card>` applique déjà la hairline, n'ajoute pas `shadow-*`.
- Sections inset : `border-t border-border-default`.
- Shadows autorisées uniquement sur les `Dialog` (et autres surfaces overlay) — `<Dialog>` les applique via `shadow-md`.

### 7.2 Le focus ring

Les primitives utilisent `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`. Le `:focus-visible` racine dans `globals.css` est un filet de sécurité pour tout élément `tabIndex`-able qui aurait été oublié.

**Ne jamais utiliser `outline-none` sans remplaçant**. Si tu vois `focus:outline-none` sans `focus-visible:ring-*` à côté, c'est un bug.

### 7.3 `prefers-reduced-motion`

`globals.css` neutralise les durations à `0ms !important` en bas du fichier — appliqué globalement. Toute animation Tailwind (`animate-spin`, `transition-colors`, …) respecte la préférence sans config supplémentaire.

### 7.4 Backdrops

`<Dialog>` utilise `backdrop:bg-black/60` (le pseudo-element `::backdrop` du `<dialog>` natif). C'est **literally** noir 60% — pas un token. Justification : le backdrop n'est pas une surface UI, c'est un voile d'attention, et il doit être _thème-indépendant_ (le contraste avec l'overlay est calibré par construction).

## 8. Lien avec la spec et les ADRs

- Spec : `docs/spec/style-guide.md`
- ADRs :
  - `docs/decisions/style-guide-token-engine-tailwind-v4.md`
  - `docs/decisions/geist-via-vercel-npm-package.md`
  - `docs/decisions/ui-primitives-from-scratch.md`
  - `docs/decisions/dark-light-prefers-color-scheme-with-override.md`

Open questions encore non tranchées (cf. spec §7.2) :

- Icon set (lucide est le candidat naturel — pas encore d'ADR).
- Components deferred (Tooltip, Dropdown, Tabs, Toast) — aucune date.

## 9. Tests

Aucun test dédié pour l'instant (visual regression et contrast probe sont deferred — cf. spec §6). Les primitives sont indirectement couvertes par les tests des composants qui les consomment (`packages/web/tests/unit/components/*.test.tsx`).

Si tu touches un primitive, lance :

```
cd /home/dev/cloud-resource-manager
npx vitest run packages/web/tests/unit/components/
```

Tous les tests doivent rester verts.
