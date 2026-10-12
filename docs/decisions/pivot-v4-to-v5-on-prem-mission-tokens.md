---
title: Pivot v4 → v5 — gateway on-prem, identités partagées, mission tokens à budget de risque
status: accepted
date: 2026-10-12
author: Renaud Pelissier
supersedes:
  - flat-membership-org-owner-access-token
  - redis-cache-upstash-with-memory-fallback
  - resend-unified-email-provider
partially-supersedes:
  - trust-model-clear-at-rest-idp-style
  - per-org-encryption-app-level
  - oauth-app-install-per-provider
  - unified-tokens-delegation-chain-and-escalation-channel
extends:
  - pivot-to-risk-based-model
  - mcp-only-mvp-scope
---

# Pivot v4 → v5 — gateway on-prem, identités partagées, mission tokens à budget de risque

> **ACCEPTED 2026-10-12** par Renaud, en session. Cadrage validé :
> SQLite, UI web conservée, budget par `risk_id`, OIDC générique,
> livraison Docker, budget récurrent par rechargement, licence AGPL-3.0,
> collecteur de télémétrie sur un projet Supabase dédié, bascule manuelle
> depuis la prod v4 (D7). Nom public du produit : **v2** ; numérotation
> interne du repo : **v5** (tag `v4-final` posé sur le dernier commit
> SaaS).

## Contexte

La v4 (mai → juillet 2026) est un gateway MCP SaaS multi-tenant : Vauban
Core héberge sur Vercel + Supabase, les orgs clientes connectent leurs
clouds via des OAuth apps détenues par l'opérateur Vaubaan, les humains
s'authentifient par GitHub SSO, le cache vit chez Upstash, les mails chez
Resend. Le modèle d'autorisation est stabilisé : catalog de risques par
provider, token portant un set fermé `accepted_risks[]`, chaîne de
délégation parent → enfant, escalation hors-gateway
([[pivot-to-risk-based-model]], [[unified-tokens-delegation-chain-and-escalation-channel]]).

Quatre constats motivent un nouveau pivot :

1. **Le produit est un serveur qui détient des tokens cloud sensibles.**
   Une entreprise ne veut pas confier ses credentials GitHub, Vercel ou
   Supabase à un SaaS tiers. Elle veut l'installer sur son VPS ou dans
   son Docker on-prem, derrière son propre IdP. La distinction
   "Vauban Core vs Customer Org" ([[architecture-two-tenants]]) n'a plus
   de raison d'être : une instance = une entreprise.
2. **Un token est émis pour un humain, pas pour un objectif.** Le token
   v4 est borné en _nature_ de risque mais pas en _quantité_ ni en
   _vitesse_. Un agent qui boucle peut faire 10 000 écritures légitimes
   en une minute. Il manque la notion de budget.
3. **Le modèle d'identité est trop plat.** Une org à owner unique, tous
   les membres en RW total ([[flat-membership-org-owner-access-token]]),
   des roots project-scoped. Impossible d'exprimer "A a connecté GitHub,
   A en partage un sous-ensemble à B, B émet des tokens encore plus
   restreints".
4. **Les plugins providers ne sont pas testables contre les services
   réels.** Pas d'environnement de test maintenable pour Stripe,
   Cloudflare ou Railway. La validation doit venir de l'usage.

Le passage en open source est décidé pour un futur proche ; il contraint
la v5 dès maintenant (licence, zéro secret ou ref de projet dans le repo,
télémétrie opt-in, process de contribution de plugins).

## Décision

**v5 = gateway on-prem mono-tenant, livré en image Docker, avec identités
partagées et mission tokens à budget de risque.** Même repo, code v4
remplacé sur `main` après tag `v4-final`. Pas de migration de données :
la prod SaaS v4 n'a qu'un utilisateur réel (Renaud) et reste allumée
jusqu'à ce que la v5 soit validée sur son propre flux de travail, puis
elle est éteinte (D7).

### D1 — Livraison et persistance

- Une image Docker unique (serveur Node + UI web Next.js servie par le
  même process). Cible : VPS d'entreprise ou Docker on-prem.
- **SQLite** comme persistance par défaut, fichier sur volume monté.
  Secrets providers chiffrés at-rest par une master key fournie à
  l'instance (env var ou fichier), dérivation par connection.
- Cache et rate-limit **in-memory mono-process**. Plus de Redis externe.
- Plus de dépendance à un service SaaS pour fonctionner : ni Supabase,
  ni Vercel, ni Upstash, ni Resend.

### D2 — Authentification humaine par OIDC générique

- Les humains s'authentifient via **n'importe quel IdP OpenID Connect**
  configuré par l'entreprise : Entra ID, Google, Keycloak, Okta…
  Configuration = issuer URL + client id + client secret + mapping des
  claims (sub, email, groups).
- Les **groupes** viennent des claims de l'IdP quand ils existent, sinon
  d'une table locale.
- Le GitHub SSO disparaît. Pas d'auth locale par mot de passe en v5 ;
  un bootstrap admin par token initial suffit pour configurer l'IdP.

### D3 — Identités, connections et partages

- Un **user** connecte des **connections** (un cloud service authentifié
  via OAuth app ou API key). Il en est l'owner.
- Un **partage** est un triplet `(connection_id, target, restriction)` où
  `target` est un user ou un groupe et `restriction` une **énumération
  explicite de `risk_id`** du catalog du provider. Pas de wildcard, pas
  de sentinel ([[feedback-explicit-risks-no-sentinel]]).
- Les OAuth apps providers sont **enregistrées par l'entreprise** pour
  son instance (client id/secret dans la config), plus par l'opérateur
  Vaubaan. L'ADR [[oauth-app-install-per-provider]] reste valide sur la
  méthode par provider, plus sur la propriété des apps.
- Les notions d'**org** et de **project** disparaissent. Les roots
  project-scoped de l'amendement 2026-06-19 sont remplacés par des
  mission tokens.

### D4 — Mission tokens, budget, session

- Un token est émis pour une **mission** (objectif nommé), ponctuelle ou
  récurrente, par un user sur une ou plusieurs connections qu'il possède
  ou qui lui sont partagées. Les `accepted_risks` de la mission sont un
  sous-ensemble de l'intersection des restrictions amont.
- La mission porte un **budget de risque par `risk_id`** : un quota
  (nombre d'actions) et un rate-limit (actions par fenêtre). Un budget
  global par mission est rejeté : cent lectures videraient le droit
  d'écrire.
- Le **premier call** crée une **session** qui trace les events et sert
  de base au calcul instantané du budget restant.
- Budget épuisé → la gateway refuse avec un message structuré contenant
  une **URL de réclamation**. La réclamation (reset ou extension) exige
  l'authentification du **créateur de la mission**. L'exécutant ne peut
  pas s'auto-augmenter. C'est le canal d'escalation existant avec un
  nouveau déclencheur.
- Mission récurrente = budget **rechargé à période fixe** sur la même
  mission. La session continue, les compteurs repartent à zéro à chaque
  période. Pas de réinstanciation.
- `expires_at` est **nullable** : une mission peut être illimitée dans le
  temps. Le budget par `risk_id`, lui, reste obligatoire. Un preset
  "projet de code" propose un quota et un rate-limit généreux pour
  couvrir l'usage actuel "un token par projet", à resserrer ensuite.

### D5 — Plugins providers : tests unitaires conservés, validation communautaire

- L'implémentation des plugins se fait sur la doc publique des
  providers (via Context7, [[use-context7-for-provider-docs]]).
- Les **tests d'intégration contre les services réels sont abandonnés**.
  Les **tests unitaires sont maintenus**, en priorité sur le
  classifieur `(tool, args) → slice, risk_id` : une erreur de
  classification est un trou de sécurité, pas un bug fonctionnel.
- Une **télémétrie opt-in** remonte succès/échec par
  `(plugin, version, tool)` vers un collecteur communautaire. Le rapport
  ne contient jamais d'arguments de call, d'identifiants de ressources
  ni de tokens. Un plugin est réputé valide au-dessus d'un seuil de
  succès publié.
- Le collecteur est un **projet Supabase dédié**, détenu par le projet
  open source, sans autre rôle. Insertion anonyme en append-only par RLS
  (clé anon, aucune lecture), agrégation par une vue publique
  `plugin_stats`. L'URL du collecteur est une valeur par défaut dans le
  code, surchargeable ou désactivable par la config d'instance. C'est la
  seule dépendance SaaS de la v5 et elle est optionnelle.

### D6 — Open source

- Licence **AGPL-3.0**. Une entreprise peut installer, modifier et
  utiliser l'instance en interne sans obligation ; seul celui qui expose
  une version modifiée en service réseau doit publier ses changements.
  Ça garde ouverte l'option d'une offre hébergée par Vaubaan sans qu'un
  tiers puisse la copier à façon fermée.
- Le repo ne contient aucun secret ni ref de projet ; tout vient de la
  config d'instance ([[feedback-env-vars-canonical]]).
- Le kit de soumission de plugins existant devient le process de
  contribution.

### D7 — Bascule manuelle depuis la prod SaaS v4

Pas de coexistence longue, pas d'export/import, pas de code de
migration. La prod v4 n'a qu'un utilisateur réel. La bascule est un
cutover manuel en trois temps :

1. **Validation.** La v5 est déployée sur une instance de Renaud et
   validée sur ses projets de code réels avant toute extinction. Le
   critère d'acceptation est écrit dans `docs/tests/e2e-tests.md` :
   connecter chaque provider utilisé aujourd'hui, émettre une mission
   par projet de code, exécuter le flux de travail quotidien avec Claude
   Code sans refus non attendu.
2. **Recréation.** Renaud reconnecte ses connections sur l'instance v5
   et émet, pour chaque projet de code concerné, une mission **illimitée
   dans le temps** avec le preset "projet de code". Il remplace le Bearer
   et l'URL `/mcp` dans le `.mcp.json` de chaque projet.
3. **Extinction.** Une fois tous les projets basculés, la prod v4 est
   éteinte et ses credentials providers révoqués côté provider.

Le passage de "un token par projet de code" à "une mission par objectif"
se fait ensuite, progressivement, sans contrainte de calendrier.

## Conséquences

### Positives

- Une entreprise garde ses credentials chez elle, derrière son IdP.
  L'argument "serveur de tokens sensibles" devient un argument pour, pas
  contre.
- Le budget par `risk_id` ferme le trou "agent qui boucle" sans toucher
  au vocabulaire d'autorisation.
- Le modèle de délégation v4 se généralise sans se réinventer : partage
  et mission sont des nœuds de la chaîne qui resserrent.
- Le domaine (policy-engine, catalogs de risques, shared) se réutilise
  tel quel. Seule la couche infra du package web est à réécrire.
- Déploiement en une commande, zéro compte SaaS à ouvrir.

### Négatives / contraintes

- Mono-process : le rate-limit et le cache ne sont pas partagés entre
  réplicas. La haute disponibilité est hors-scope v5.
- SQLite impose un seul writer. Suffisant pour une entreprise, pas pour
  un hébergement mutualisé.
- Chaque entreprise doit enregistrer ses propres OAuth apps chez chaque
  provider. L'onboarding est plus long qu'en SaaS.
- La validation communautaire des plugins est faible au lancement :
  peu d'instances, peu de rapports. Les premiers plugins sont réputés
  non validés.
- Réécriture du package web (139 fichiers) et des 42 migrations Supabase
  en schéma SQLite.
- La v4 reste allumée et facturée (Vercel, Supabase, Upstash, Resend)
  jusqu'à validation de la v5. Le risque est de la laisser traîner ; la
  révocation des credentials providers côté v4 fait partie du critère de
  fin.
- Le preset "projet de code" avec mission illimitée dans le temps
  reproduit le modèle v4 et n'apporte pas le bénéfice du budget tant que
  Renaud ne resserre pas. C'est assumé comme transitoire.
- AGPL-3.0 freine certaines entreprises dont la politique interdit
  toute licence copyleft, même pour un usage interne.
- Les ADRs supersédées ne sont pas réécrites ; les handbooks
  `auth-github-sso`, `web-app`, `mcp-gateway` et `escalation` deviennent
  historiques jusqu'à réécriture.

## Alternatives rejetées

### Rester SaaS et ajouter un mode "bring your own IdP"

Ne répond pas au constat 1 : les tokens cloud restent chez un tiers.

### Postgres obligatoire au lieu de SQLite

Plus robuste pour le multi-réplica, mais ajoute un service à opérer pour
une cible qui est un VPS ou un poste. SQLite par défaut, Postgres
réévalué si la demande HA apparaît.

### Garder l'auth locale par mot de passe

Oblige à gérer reset, MFA, politique de mots de passe. L'entreprise
cible a déjà un IdP ; OIDC générique couvre Entra ID, Google et les
autres sans code spécifique.

### Budget global par mission

Plus simple à configurer, mais un budget de N actions se consomme en N
lectures et ne protège aucune écriture. Rejeté au profit du budget par
`risk_id`.

### Renoncer entièrement aux tests des plugins

Proposé initialement. Rejeté : ce qui est impossible, c'est le test
d'intégration contre le service réel, pas le test unitaire du
classifieur sur des réponses enregistrées. La télémétrie complète, elle
ne remplace pas.

### Nango comme couche de connections

Plateforme open source qui gère OAuth, stockage chiffré et refresh de
tokens pour plusieurs centaines d'APIs. Couvre exactement la couche que
la v4 possède déjà, et rien d'autre : ni policy, ni MCP, ni budget.
Auto-hébergé, il ajoute un serveur, un Postgres et un Redis à une image
qui vise la simplicité. Rejeté pour le cœur de la v5 ; porte ouverte à
un backend de credentials optionnel plus tard.

### Nouveau repo pour la v5

Perd l'historique des ADRs et du domaine réutilisé. Même repo, tag
`v4-final`, comme pour v3 → v4.

### Export/import par org depuis la v4 (coexistence longue)

Envisagé en première version de cet ADR : v4 gelée, bundle d'export
chiffré par org, import au premier démarrage, conservation des hashes
`vbn_live_`. Rejeté : la v4 n'a qu'un utilisateur réel, le code de
migration serait jetable, et le mapping project → partages perdait de
l'information. Recréer trois connections et quelques tokens à la main
coûte moins qu'un outil de migration testé.

### Mission récurrente par réinstanciation

Une nouvelle mission et une nouvelle session à chaque occurrence.
Rejeté : multiplie les Bearers à redistribuer aux agents. Le
rechargement périodique garde un Bearer stable et un historique continu.

### Apache-2.0

Adoption maximale, aucune friction en entreprise. Rejeté : n'empêche pas
un tiers de proposer le gateway en SaaS fermé, ce qui est précisément
le marché que Vaubaan pourrait vouloir occuper.

### Collecteur de télémétrie via dépôt GitHub et Action

Les instances ouvriraient des issues ou des commits de rapport. Rejeté :
un dépôt GitHub n'est pas un endpoint d'ingestion, le rate-limit et la
modération deviennent un problème. Un projet Supabase dédié en
insertion anonyme append-only est plus simple à opérer.

## Références

- Spec v5 à rédiger : `docs/spec/vaubaan-gateway.md` (réécriture
  complète, remplace la spec v4 et ses cinq notes d'amendement).
- Spec conservée : [[gateway-risk-model]].
- ADRs étendues : [[pivot-to-risk-based-model]],
  [[unified-tokens-delegation-chain-and-escalation-channel]],
  [[mcp-only-mvp-scope]].
- Précédent méthodologique : [[pivot-v3-to-v4-policy-gateway]].
- Nango : https://www.nango.dev
