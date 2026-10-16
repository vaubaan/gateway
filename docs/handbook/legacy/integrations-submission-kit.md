---
title: OAuth & marketplace submission kit
status: legacy
date: 2026-05-26
---

> **Legacy v4 document.** Kept for history; superseded by the v5 spec. Not maintained.

# Integrations submission kit

Tout ce qu'il faut pour passer la revue d'un provider (GitHub App
Marketplace, Vercel Integration, Supabase Partner) sans s'y reprendre à
deux fois. Source de vérité pour chaque URL, copy et asset demandé.

> Production URL canonique : `https://vaubaan.com`. Toutes les URLs ci-dessous
> doivent pointer vers cette origine pour les soumissions publiques.

## 0. Pages publiques disponibles

| Page              | URL                    | Statut             |
| ----------------- | ---------------------- | ------------------ |
| Landing           | `/`                    | ✓ refondue (light) |
| Pricing           | `/pricing`             | ⚠ à écrire         |
| Privacy policy    | `/privacy`             | ✓                  |
| Terms of service  | `/terms`               | ✓                  |
| Security          | `/security`            | ✓                  |
| DPA (GDPR)        | `/dpa`                 | ✓                  |
| Subprocessors     | `/subprocessors`       | ✓                  |
| About             | `/about`               | ✓                  |
| Contact / support | `/contact`, `/support` | ✓                  |
| Brand assets      | `/brand`               | ✓                  |
| Integrations      | `/integrations`        | ✓                  |
| Changelog         | `/changelog`           | ✓                  |
| Login             | `/login`               | ✓                  |
| Dashboard         | `/dashboard`           | ✓ (auth required)  |

## 1. Assets visuels à préparer

Tous sous `packages/web/public/marketing/` (servis depuis `vaubaan.com/marketing/...`).

```
packages/web/public/marketing/
  screenshots/
    dashboard-overview.png        # 1440×900, dashboard org list
    org-providers.png             # 1440×900, page org avec providers connectés
    audit-log.png                 # 1440×900, audit log avec mix allow/deny
    role-editor.png               # 1440×900, role custom avec deny rules
    mcp-client-config.png         # 1440×900, mcp.json + claude code session
  social/
    og-default.png                # 1200×630, OG card par défaut
    og-security.png               # 1200×630, OG pour /security
  brand/
    icon-512.png                  # déjà dans public/logo-vaubaan.png
    icon-256.png                  # à régénérer 256×256
    icon-128.png                  # à régénérer
    wordmark-light.svg            # logo + nom, fond clair
    wordmark-dark.svg             # logo + nom, fond sombre
```

**Comment capturer** :

1. `npm run dev` dans `packages/web`.
2. Connecter le faux customer (`.env.test`) avec `bash scripts/seed-customer.sh`.
3. Capturer en `1440×900` (devtools → device toolbar → responsive 1440×900).
4. Light theme par défaut. Capturer aussi en dark si demandé (Supabase préfère).
5. Caviarder les emails sensibles : remplacer par `org1-admin@vaubaan.com`
   (déjà un faux email du `.env.test`).

## 2. GitHub App Marketplace

Formulaire : https://github.com/marketplace/new

| Champ                        | Valeur                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| Listing name                 | `Vaubaan — Policy-enforcing MCP gateway`                                 |
| Short description (80 chars) | `Filter and audit every MCP tool call. The agent never sees the secret.` |
| Categories                   | `Code review`, `Security`, `Continuous integration`                      |
| Homepage URL                 | `https://vaubaan.com`                                                    |
| Privacy policy URL           | `https://vaubaan.com/privacy`                                            |
| Terms of service URL         | `https://vaubaan.com/terms`                                              |
| Support URL                  | `https://vaubaan.com/support`                                            |
| Status URL                   | `https://status.vaubaan.com` (à provisionner avant submit)               |
| App logo (PNG, 200×200 min)  | `public/logo-vaubaan.png` (regénérer en 512×512 propre)                  |
| Feature screenshots (1–5)    | `marketing/screenshots/{dashboard-overview,org-providers,audit-log}.png` |
| Verified domain              | `vaubaan.com` (verify via DNS TXT — ajouter au DNS Cloudflare)           |
| Permissions justifiées       | voir §2.1                                                                |

### 2.1 Permissions GitHub App (à justifier au reviewer)

| Permission      | Niveau | Justification courte                                                    |
| --------------- | ------ | ----------------------------------------------------------------------- |
| Contents        | RW     | Tools `create_or_update_file`, `push_files`, `get_file_contents`.       |
| Pull requests   | RW     | Tools `create_pull_request`, `list_pull_requests`, `add_issue_comment`. |
| Issues          | RW     | Tools `create_issue` (futur), `list_issues`, `add_issue_comment`.       |
| Metadata        | R      | Auto (toujours requis).                                                 |
| Commit statuses | RW     | À retirer si pas exposé en tool (vérifier `tools.ts`).                  |
| Webhooks        | —      | Pas utilisé pour le MVP, ne pas demander.                               |

> **Note review GitHub** : leur reviewer veut une captation d'écran du flow
> d'install consent + un screencast de ≤ 60s montrant un tool call refusé
> dans l'audit log. À enregistrer une fois la prod stable.

## 3. Vercel Integration

Console : https://vercel.com/integrations/console/

| Champ                       | Valeur                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| Integration name            | `Vaubaan`                                                               |
| Slug                        | `vaubaan`                                                               |
| Category                    | `Security`                                                              |
| Short description           | `Audit and policy-enforce MCP tool calls hitting your Vercel projects.` |
| Long description (markdown) | voir `docs/handbook/vercel-listing.md` (à créer si besoin)              |
| Logo (PNG 256×256 ou SVG)   | `public/logo-vaubaan.png` ou `.svg`                                     |
| Cover image (1280×640)      | À designer (capture + tagline)                                          |
| Screenshots (≥ 3, 1440×900) | `screenshots/dashboard-overview`, `audit-log`, `role-editor`            |
| Website URL                 | `https://vaubaan.com`                                                   |
| Support URL                 | `https://vaubaan.com/support`                                           |
| Documentation URL           | `https://github.com/sbw-vaubaan/vaubaan-gateway#readme`                 |
| Configuration URL           | `https://vaubaan.com/orgs/{org}/providers/vercel/connect`               |
| Webhook URL (optional)      | n/a au MVP                                                              |
| Allowed scopes              | `read-projects`, `read-deployments`, `read-env`                         |

> Vercel demande un **screencast** du flux d'install et un **email
> support** dédié (`support@vaubaan.com`). Configurer la boîte avant.

## 4. Supabase Partners

Page : https://supabase.com/partners

| Champ              | Valeur                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| Partner name       | `Vaubaan`                                                              |
| Category           | `DevTools`, `Security`                                                 |
| Logo (SVG ou 512²) | `public/logo-vaubaan.svg`                                              |
| Tagline (80 ch.)   | `Policy-enforcing MCP gateway. The agent never sees the Supabase PAT.` |
| Description        | Reuse `/about` + `/security` content                                   |
| Website            | `https://vaubaan.com`                                                  |
| Docs URL           | `https://github.com/sbw-vaubaan/vaubaan-gateway#readme`                |
| Demo URL           | `https://vaubaan.com/login` (preview org)                              |
| Support email      | `support@vaubaan.com`                                                  |
| Privacy URL        | `https://vaubaan.com/privacy`                                          |
| Terms URL          | `https://vaubaan.com/terms`                                            |

> Supabase reviewer veut savoir **où sont stockées les Mgmt PAT** et
> **comment elles sont chiffrées**. Réponse : ligne par ligne, AES-256-GCM,
> clé KMS hébergée chez Supabase Vault (cf. `/security#token-model`).

## 5. Checklist avant submit (commune)

- [ ] Le domaine `vaubaan.com` répond en HTTPS et redirige `www →` apex.
- [ ] DNS verified pour GitHub (TXT record), Vercel (CNAME) et Supabase.
- [ ] Toutes les pages publiques répondent en 200 (pas de placeholder TODO).
- [ ] Les emails `hello@`, `support@`, `security@`, `privacy@`, `legal@`,
      `press@`, `trust@`, `dpa@` redirigent vers une vraie boîte
      monitorée (au moins forward vers une boîte ops).
- [ ] La page d'install OAuth (`/orgs/[slug]/providers/<p>/connect`) gère
      proprement les erreurs et affiche la consent expectation.
- [ ] Screencast ≤ 60s prêt (install + 1 allow + 1 deny dans l'audit log).
- [ ] Status page (`status.vaubaan.com`) provisionnée — un Statuspage gratuit
      ou un repo `upptime` suffit.
- [ ] Un email reviewable signé par DPO (`dpa@vaubaan.com`) prêt à
      envoyer si une grande entreprise demande un DPA contre-signé.

## 6. Ce qui reste à écrire

- `/pricing` — page tarifs (Free / Team / Enterprise). Bloquant pour le
  submit Vercel (catégorie billing).
- Statut page (Statuspage / Upptime).
- Screencast 60s : à enregistrer dès la prod stable.
- OG cards (`marketing/social/*.png`).
- Brand wordmark light/dark (SVG).
- Marketing screenshots (5 captures listées au §1).

> Une fois ces 6 items terminés, on peut soumettre les 3 listings en
> parallèle. Le plus long sera GitHub (~2 semaines de review en moyenne).
