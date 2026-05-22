---
title: Geist Sans + Geist Mono via le package npm `geist`
status: accepted
date: 2026-05-22
author: rpelissier
tracks:
  - packages/web/src/app/layout.tsx
  - packages/web/src/app/globals.css
  - packages/web/package.json
---

# Geist Sans + Geist Mono via le package npm `geist`

## Contexte

La spec `docs/spec/style-guide.md` §7.1 acte le choix de **Geist Sans + Geist Mono** comme famille typographique bundlée (pas de fallback system-only). Reste à choisir _comment_ les embarquer. La spec §7.2 liste trois options ouvertes :

1. Package npm `geist` officiel (publié par Vercel, wrapper `next/font`).
2. Self-hosted woff2 (téléchargés depuis `vercel/geist-font`, servis en static).
3. Google Fonts (Geist y est disponible).

Contraintes :

- Le projet déploie sur Vercel (cf. `docs/decisions/stack-nextjs-supabase-vercel.md`).
- Pas de FOIT visible (font-display swap minimum).
- Pas de fuite RGPD via CDN tiers.
- Maj des fontes triviale (pas de checkout manuel à chaque release).

## Décision

On adopte **le package npm `geist`** (`geist@^1.7.1` installé sous `packages/web`), via les exports `geist/font/sans` et `geist/font/mono`.

Le binding se fait dans `app/layout.tsx` :

```tsx
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';

<html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
```

`globals.css` consomme les CSS variables injectées :

```css
@theme inline {
  --font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

Le fallback system-ui reste en place au cas où l'asset ne charge pas (ex. mode offline complet du navigateur).

## Conséquences

### Positives

- **Auto-hosting Next.js.** Le package est un wrapper `next/font` : Next copie les fichiers woff2 dans `.next/` au build, les sert depuis le même domaine, et émet les `<link rel="preload">` automatiquement. Zéro config supplémentaire.
- **Pas de FOIT.** `next/font` applique `font-display: swap` par défaut, le texte est lisible immédiatement avec le fallback puis swap quand le woff2 arrive.
- **Pas de CDN tiers.** Pas de hit Google Fonts, pas de fuite IP user vers `fonts.googleapis.com`, pas de dépendance réseau externe pour le first paint. Aligné avec la posture privacy du projet (cf. spec CRM §1 "ZK invariant" — l'esprit du projet est de minimiser les fuites).
- **Maj triviale.** `npm update geist` ; un seul fichier `package.json` à toucher.
- **Officiel Vercel.** Aligné avec le design system source. Pas de risque de divergence entre versions de Geist sur npm vs sur le site Vercel.

### Négatives / contraintes

- **Bundle impact mesurable.** Le package ship ~6 fichiers woff2 (regular, medium, bold × sans/mono). Total ~250-300 KB. Servis avec long-cache header par Vercel, donc one-time cost — mais c'est plus que les 0 KB d'une option "system stack only".
- **Lock-in léger sur next/font.** Si on quittait Next.js, il faudrait passer en self-hosted (woff2 statiques + `@font-face`). Migration triviale (10 min) mais non-zéro.
- **Pas de preview pour customiser** les axes variables fins (font-feature-settings autres que `cv11`/`ss01`). Le package expose un set fixé. Si on voulait `cv02`, `ss02`, etc., il faudrait switcher en self-hosted.

## Alternatives rejetées

### Self-hosted woff2

Cloner les fichiers de `vercel/geist-font` dans `packages/web/public/fonts/`, écrire les `@font-face` à la main.

Avantages : contrôle total sur les features OpenType, sur le subset, sur le chemin de cache. Inconvénients :

- Plus de boilerplate (3-4 `@font-face` blocks par poids × style).
- Maj manuelle à chaque release de Geist (download + diff + commit).
- Pas d'optimisations automatiques `next/font` (preload, subsetting auto).

Refusé pour la maintenance.

### Google Fonts

`<link href="https://fonts.googleapis.com/css2?family=Geist&family=Geist+Mono">`.

Avantages : zéro install. Inconvénients :

- Dépendance réseau externe pour le first paint.
- Fuite RGPD (Google voit l'IP de chaque visiteur).
- Pas de garantie de version (Google peut mettre à jour Geist sans préavis).
- Anti-pattern produit pour un outil orienté secret-management privacy-first.

Refusé en priorité.

### System stack uniquement (pas de Geist)

`font-family: system-ui, -apple-system, "Segoe UI", ...`.

Avantages : 0 KB bundle. Inconvénients :

- L'esthétique varie selon l'OS (San Francisco sur macOS ≠ Segoe UI sur Windows ≠ Roboto sur Android). Le rendu Vercel-like est perdu.
- Contredit la décision spec §7.1.

Refusé par la décision amont (la spec a déjà tranché : Geist bundled, pas system-only).
