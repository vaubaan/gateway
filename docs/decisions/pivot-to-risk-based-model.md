---
title: Pivot vers le modèle risk-based (token = accepted_risks, pas capabilities)
status: accepted
date: 2026-06-15
supersedes:
  - policy-dsl-declarative-jsonb
  - roles-naming-provider-scoped
  - sql-classification-syntactic-only
partially-supersedes:
  - env-less-grant-fan-out-with-binding-exclude
---

# Pivot vers le modèle risk-based

> **ACCEPTED 2026-06-15** par Renaud ("vas-y fais tout"). Décisions
> structurantes tranchées dans cette ADR (cf. §Décisions tranchées
> ci-dessous). Sera affiné en cours d'implémentation si la pratique
> invalide des hypothèses. Spec source de vérité :
> [[gateway-risk-model]] (v4). Audit :
> [`/.vaubaan/reports/v4-coherence-audit.md`](../../.vaubaan/reports/v4-coherence-audit.md).
> Plan migration : [`/.vaubaan/reports/v4-migration-plan.md`](../../.vaubaan/reports/v4-migration-plan.md).

## Contexte

Trois itérations successives ont été tentées pour modéliser ce qu'un
agent IA peut faire à travers la gateway :

- **v1 — Rings concentriques** (`{provider, plane, level, action, env?}`,
  4 levels par pile : `content/structure/governance/access`). Élégant
  théoriquement (invariant "niv k+1 gouverne niv k") mais 15-20
  capabilities émissibles par provider, opérateur perdu.
- **v2 — Macro-permissions** (`inspect/read/mutate/destroy/govern`).
  Vocabulaire universel mais oversimplifie pour un Story Dev qui
  maîtrise déjà ses providers. Crée plus de confusion (« `govern` chez
  Vercel = env vars + domains + protection ? ») qu'elle n'en retire.
- **v3 — Slices DSL** (path-based selectors style XPath / Cedar). Très
  expressif mais demande au manager d'**anticiper** ce que l'agent va
  toucher — hypothèse fausse en pratique pour un coding agent autonome
  (sous-grant → blocage mid-session, sur-grant → perte du least-privilege).

**Le shift conceptuel** : on raisonne **risk-based**, pas
capability-based. Le manager ne dit pas "voici ce que l'agent peut
faire" — il dit "voici les conséquences que j'accepte". L'agent agit
ensuite librement dans cet espace de risque.

C'est ce que font Google Adaptive Auth, Microsoft Conditional Access,
OAuth Step-Up (RFC 9470), Claude Code Auto Mode. Vaubaan rejoint un
pattern bien établi sous un autre angle.

## Décision

**Le token porte `accepted_risks: RiskId[]` qualifiés par binding, plus
`bindings: ProjectBinding[]`. Pas de capability, pas de slice, pas de
macro, pas de DSL.**

Trois piliers :

1. **Plugin (par provider, code)** : déclare un `dataModel`
   (entités + cardinalités + containment du plane) et un `classify(t,a)`
   qui retourne la `Slice[]` touchée au call. **Plomberie interne** :
   l'opérateur ne voit jamais les slices.

2. **Catalogue de risques (par provider, YAML versionné dans le repo)** :
   ~10-15 `RiskEntry` par provider, chacune avec
   `{id, label, reason, matches (slice pattern), vector (6D), default_gate}`.
   Un fallback générique par provider (`<vendor>.uncategorized-write`)
   garantit qu'aucune action ne passe sans être catégorisée.

3. **Project policy (DB, par-projet)** : table légère
   `project_risk_policies (risk_id, env_scope, gate)` qui override le
   `default_gate` du catalogue. Pas de DSL.

**Runtime au call** : `intersect(slices, catalog) → risks_touched`,
puis `risks_touched ⊆ token.accepted_risks` → ALLOW. Sinon 403
`risk-not-accepted`. **Strict-fail au MVP** (pas de step-up runtime),
agent demande au Story Dev de re-minter.

**Mint flow** : POST `/api/v1/mgmt/tokens/preview` renvoie les risks et
leurs `effective_gate` pour UI. POST `/api/v1/mgmt/tokens` mint
direct si tous `allow`, ou crée un `approval_request` si un `confirm`
existe (channel Telegram + Manual + nouveau Email, fan-out
multi-canal).

## Conséquences

### Wire — casse compat

| Avant                                                              | Après                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `access_tokens.capabilities: Capability[] jsonb`                   | `access_tokens.accepted_risks: RiskId[] jsonb`                              |
| `POST /mgmt/tokens { capabilities: [...] }`                        | `POST /mgmt/tokens { bindings, accepted_risks }`                            |
| `policy_rules (provider, plane, level, action, env_pattern, gate)` | `project_risk_policies (risk_id, env_scope, gate)`                          |
| `audit_log.capability_matched`                                     | `audit_log.{slices_executed, risks_touched, token_accepted_risks_snapshot}` |

Pas de back-compat : les tokens v1 actifs sont révoqués au prochain call
(pas de mapping automatique cap→risk possible safely).

### Simplification

- Plus de DSL JSON 7-opérateurs (supersede `policy-dsl-declarative-jsonb`).
- Plus de table `roles` (déjà droppée v2, supersede
  `roles-naming-provider-scoped` à nouveau).
- Plus de parser SQL pour classifier `execute_sql` (supersede
  `sql-classification-syntactic-only`) : execute_sql devient strict
  read-only via Postgres lui-même.
- `policy_rules` (matrice large) → `project_risk_policies` (table légère
  d'override).

### Surface API rétrécie

- `github__dispatch_workflow`, `github__cancel_workflow_run`,
  `github__rerun_workflow_run` **retirés**. Un agent qui a
  `vercel.deploy-*` ou `supabase.migration.W` n'a pas besoin de hook
  GitHub pour déclencher des effets. Ferme la classe d'escalation par
  confused deputy via workflow secret.
- `supabase__execute_sql` : R only. Toutes les W passent par les 13
  tools API granulaires data-plane déjà shipped.

### Enrichissement

- Audit log : `slices_executed` (technique) + `risks_touched`
  (intention métier) + snapshot des `accepted_risks` du token.
  Conforme aux exigences Five Eyes (2026-05) et NIST AI RMF Agentic
  Profile sur la traçabilité 100% par action.
- Channels approval : ajout d'`EmailChannel` (Resend/Postmark + JWT
  signing). Multi-canal simultané possible.
- Long-poll : nouvelle route `GET /pending/:id?wait=25` (capé sous
  Vercel Edge 25s avant 1er byte, Cloudflare 100s origin idle).
  Le SDK re-poll jusqu'au TTL (15 min default).

### Effort de migration

8 phases sur ~3 semaines de dev focus full-time. Détails dans
[`/.vaubaan/reports/v4-migration-plan.md`](../../.vaubaan/reports/v4-migration-plan.md).

## Alternatives rejetées

### Garder v3 (slices comme grant)

Le manager devrait écrire des selecteurs (`github.repo[*].branch[main].W`)
au moment du mint. Ça reste capability-based, juste plus expressif.
Échec à résoudre le pb fondamental : _anticipation_ de la trajectoire
de l'agent.

### Garder v2 (5 macros : inspect/read/mutate/destroy/govern)

Plus simple côté UI mais oversimplifie pour le Story Dev qui maîtrise
le provider. Crée du frottement mental ("`govern` chez Vercel ça
englobe quoi exactement ?"). Slack a publiquement regretté son
umbrella `bot` scope pour exactement cette raison.

### Cedar / OPA full-engine

Adopter un moteur de policy mature (Cedar AWS, OPA/Rego) avec full
predicate algebra. Power max mais : (a) overkill pour les ~5 providers
qu'on a, (b) friction d'onboarding ops, (c) prompt-injection sur le
moteur de policy lui-même si on l'utilise dynamiquement. Notre catalogue
de risques est plus _prescriptif_ (10-15 intentions métier par provider)
et plus aligné avec le mental model d'un Story Dev qu'un PolicyAsCode
universel.

### LLM-as-classifier (Anthropic Auto Mode style)

Faire trancher chaque tool call par un LLM ("auto-approve safe, prompt
ambigu, block dangerous"). Inconvénients : prompt injection sur le
classifieur ; latence ajoutée ; coût ; pas explicable ; pas tooling-able
pour les audits. Acceptable comme overlay UI (suggestion d'auto-allow)
mais pas comme moteur de décision canonique.

## Décisions tranchées (2026-06-15)

### D1 — Override `deny → allow` (anti-pattern guard)

**Accepté** : interdit en SQL CHECK pour les risks dont le vecteur
catalogue contient `persistence: posture` OU `data: secret` (côté W).
Pour les autres, l'override `deny → allow` reste possible mais demande
le role `admin` côté org_members (vérification applicative au mint).
Justification : conforme Five Eyes 2026-05 + esprit "fail-closed
sur posture".

### D2 — Format `RiskId`

**Accepté** :

- `<provider>[<env>].<name>` pour les risks env-scoped (ex:
  `supabase[staging].bulk-row-write`, `vercel[prod].env-var-write`).
- `<provider>.<name>` pour les non-env-scoped (ex:
  `github.mint-install-token`, `vercel.deploy-preview` quand fan-out).
- Regex SQL CHECK : `^[a-z][a-z0-9]*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$`.
- Slug interne du risque : kebab-case, `[a-z][a-z0-9-]+`.

### D3 — Step-up runtime

**Accepté différé en Phase 2.** Au MVP : strict 403
`risk-not-accepted` avec liste des missing_risks + slice exécutée +
hint actionnable. Agent revient au Story Dev qui re-mint. Phase 2
introduira un step-up runtime avec token mutable atomique si demande
émerge.

### D4 — Profils réutilisables (presets)

**Accepté MVP-light** : duplicate "Copy from previous token" + "Save
as preset" sur la Mint page. Pas de feature lourde (templating,
partage entre orgs). 1 jour de dev. Justification : sans presets,
20-40 clics par session = trop lourd pour le Story Dev qui itère.

### D5 — `acceptable_in_envs` strict

**Accepté** : un risk dont le catalogue déclare
`acceptable_in_envs: ['staging']` ne peut PAS être accepté pour un
binding `env: prod`, **même si la project policy l'autorise en `allow`**.
Garde-fou structurel. Validation applicative au mint (l'env vient du
binding, pas du catalogue → pas SQL CHECK).

### D6 — UI risks `deny`

**Accepté** : greyed-out + tooltip "blocked by project policy
(admin-only override)". Meilleure découvrabilité.

### D7 — Multi-channel approval

**Accepté** : `project_approval_channels.project_id` n'est plus
PRIMARY KEY ; clé composite `(project_id, channel)`. Permet
Telegram + Email simultanés pour fan-out / redondance.

### D8 — Catalog storage

**Accepté** : catalogue YAML versionné dans le repo
(`packages/providers/<vendor>/src/risk-catalog.yaml`), loadé au boot
de la web app. **Pas de table SQL** au MVP. Justification : version
contrôle natif, review en PR, atomicité au déploiement. Si on a un
jour besoin d'overrides ops sans redeploy, on ajoutera une table
`provider_risk_catalog_overrides` qui shadow le YAML.

### D9 — Versioning catalog (ajout d'un risk)

**Accepté fail-closed** : ajouter un nouveau risk → tokens existants
qui ne l'ont pas accepté tombent en `risk-not-accepted` au prochain
call qui matche la slice du nouveau risk. UI signale "X tokens à
re-minter pour couvrir le nouveau risque `yzz`". Pas de migration
automatique des tokens.
