---
title: Bascule dark/light — `prefers-color-scheme` + override `localStorage`
status: accepted
date: 2026-05-22
author: rpelissier
tracks:
  - packages/web/src/app/layout.tsx
  - packages/web/src/app/globals.css
---

# Bascule dark/light — `prefers-color-scheme` + override `localStorage`

## Contexte

La spec `docs/spec/style-guide.md` §1 prescrit le support dual dark+light dès la v1. §7.2 (open question) liste deux stratégies de bascule :

1. **Automatique via `prefers-color-scheme`** : on suit la préférence OS, point.
2. **Toggle user persisté** : un bouton dans la nav, persistance en localStorage / cookie.
3. **Combinaison** : `prefers-color-scheme` par défaut, override user possible.

Contraintes :

- Pas d'UI de toggle en v1 (cf. spec §3.3 deferred composants — pas de DropdownMenu).
- L'UI doit pouvoir être _testée_ en dark et light pendant le dev sans dépendre du réglage OS.
- Pas de FOUC (flash dark→light ou vice-versa au load).
- Le toggle UI viendra plus tard (v1.x) ; le mécanisme doit déjà être en place pour qu'il suffise alors d'ajouter le bouton.

## Décision

On adopte la **combinaison** : `prefers-color-scheme` comme défaut, `localStorage['crm.theme']` comme override quand l'utilisateur a explicitement choisi.

### Mécanisme

1. **CSS** (`globals.css`) déclare les semantic tokens light sur `:root`, puis les override dark dans deux blocs :

   ```css
   :root[data-theme='dark'] {
     /* dark tokens */
   }
   @media (prefers-color-scheme: dark) {
     :root:not([data-theme='light']) {
       /* dark tokens */
     }
   }
   ```

   La règle `:not([data-theme='light'])` permet à un user en dark-OS de forcer light via override sans que le media query le ramène en dark.

2. **Bootstrap inline** (`layout.tsx`) injecte un `<script>` minimal dans `<head>` qui s'exécute AVANT le premier paint :

   ```js
   var t = localStorage.getItem('crm.theme');
   if (t === 'dark' || t === 'light') {
     document.documentElement.setAttribute('data-theme', t);
   }
   ```

   Si `localStorage` est bloqué (mode privé strict, …), on tombe silencieusement en mode auto.

3. **Toggle dev** : `localStorage.setItem('crm.theme', 'dark' | 'light')` + reload. UI publique à venir en suivi.

### Trois sources, ordre de priorité

| Priorité | Source                                                    | Effet                             |
| -------- | --------------------------------------------------------- | --------------------------------- |
| 1        | `<html data-theme="dark">` ou `<html data-theme="light">` | force la palette                  |
| 2        | `prefers-color-scheme: dark`                              | dark (sauf si data-theme='light') |
| 3        | défaut                                                    | light                             |

## Conséquences

### Positives

- **Default user-respectueux.** Un visiteur qui n'a jamais touché le toggle obtient sa préférence OS. Vrai pour la grande majorité.
- **Override possible.** L'utilisateur peut forcer light sur un device dark, et inversement. Persistance par device (localStorage).
- **Zero FOUC.** Le bootstrap inline s'exécute synchronement avant le paint — l'attribut `data-theme` est sur `<html>` avant le premier render React. Pas de flash.
- **Mécanisme prêt pour le toggle UI futur.** Quand on ajoutera un bouton, il aura juste à `setItem` / `removeItem` puis `setAttribute` ; le CSS est déjà câblé.
- **Dev/staging testable.** Un développeur peut basculer manuellement via console DevTools, indépendamment de son réglage OS.
- **`prefers-reduced-motion`** est honoré indépendamment (cf. globals.css, `prefers-reduced-motion` est lu en plus, pas en compétition).

### Négatives / contraintes

- **Bootstrap = JS inline.** On ship un petit script dans `<head>`. Il faut le maintenir à jour si on touche au mécanisme. Atténué : le script fait 1 ligne, lisible.
- **Pas de fallback cookie.** Si on doit un jour rendre la préférence visible côté server (pour un SSR theming différencié sans bootstrap), il faudra passer en cookie + middleware. Le bootstrap actuel garde la décision client-only.
- **Double déclaration du bloc dark.** Le set de semantic tokens dark est répété dans `[data-theme='dark']` et dans `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])`. Refactor possible avec `@custom-variant` ou un mixin — non fait en v1, trop tôt.
- **Pas de "theme=system"** explicite. Un user qui a forcé `dark`, puis veut revenir à "suis l'OS", doit `removeItem('crm.theme')` (pas exposé en UI v1). Quand on ajoutera le toggle UI, il faudra une 3ème option "Auto/System" pour reset.

## Alternatives rejetées

### `prefers-color-scheme` seul (pas d'override)

Pure media query, pas de localStorage, pas de bootstrap script.

Avantages : zéro JS, zéro persistance, complexité minimale.

Refusé parce que :

- Empêche tout testing dev autre que de changer le réglage OS.
- Impossible pour un user de forcer light sur un device dark sans changer le système.
- Bloque le futur toggle UI (il faudrait alors tout refactorer).

### Toggle user persisté seul (pas de `prefers-color-scheme`)

Default light, l'utilisateur doit cliquer pour passer en dark, la préférence est persistée.

Refusé parce que :

- Default light est hostile sur un OS en dark.
- Vauban Core est plutôt utilisé par des devs (CRM avec terminaux, JSON, secrets) — public massivement OS-dark.

### Cookie au lieu de localStorage

Persistance via cookie pour permettre au server de connaître la préférence et SSR la bonne palette directement.

Avantages : pas de FOUC sans bootstrap script.

Refusé parce que :

- Ajoute un round-trip cookie sur chaque request (overhead minor, mais existe).
- Le bootstrap inline résout déjà le FOUC sans cookie.
- Cookie = footprint visible (jeté dans `document.cookie`, envoyé à chaque request). LocalStorage = footprint client-only.

À revisiter SI on a un usecase server-rendered différencié (genre opengraph image qui doit matcher le thème). Pas le cas en v1.

### Class `dark` sur `<html>` (Tailwind convention)

Au lieu de `data-theme='dark'`, utiliser `<html class="dark">` et exploiter le mode dark Tailwind via `@variant dark`.

Refusé parce que :

- Tailwind v4 supporte les deux approches (`@variant dark` et `[data-theme]`).
- `data-theme` est plus extensible : permet `data-theme="custom-brand"` plus tard si besoin (improbable mais pas exclu).
- Convention sémantique : `data-*` attributes sont conçus exactement pour ça ; `class` est moins lisible quand on a 3 thèmes (system/dark/light).
