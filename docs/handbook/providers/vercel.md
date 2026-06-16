---
title: Vercel provider — modélisation v4 risk-based
status: current
date: 2026-06-15
tracks:
  - packages/providers/vercel/src/data-model.ts
  - packages/providers/vercel/src/risk-catalog.ts
  - packages/providers/vercel/src/risk-catalog.yaml
  - packages/providers/vercel/src/risk-classifier.ts
---

# Vercel provider — modélisation v4

Document de travail pour la **bascule du provider Vercel** depuis le modèle
capability-based v1 (`(plane, level, action, env)`) vers le modèle
risk-based v4 (`accepted_risks[] + bindings[]`). Cible :

- Un **data-model** explicite pour le plane `runtime` (sert au classify + au
  pattern matching du catalogue).
- Un **mapping tool → slice(s)** exhaustif (27 tools exposés : 18 upstream
  rewrap de `mcp.vercel.com` + 9 custom REST).
- Un **catalogue de risks** (≈ 12 entrées + fallback) avec vecteur 6D
  raisonné et `acceptable_in_envs` quand pertinent.
- Une **matrice de couverture** tool × risk garantissant qu'aucun tool ne
  tombe dans le vide.
- Un point sur les **edge cases** structurels du provider (DNS posture-shift,
  fan-out env-var, deployment-protection governance).
- Un récap des **trous** qui demandent une décision humaine avant codage.

Sourcing : spec v4 §2.4 (data-model Vercel), §3 (DSL slice), §4 (catalogue),
classifier `classify.ts:32-67` (TOOL_KIND complet), `custom-tools.ts`
(9 custom REST), handbook `docs/handbook/vercel-provider.md` (concepts
supportés/non), Context7 `/llmstxt/vercel_llms-full_txt` (semantics Vercel
"team / project / deployment / env-var", 2026-05-31).

---

## 1. Data-model du plane `runtime`

> _« Un provider est une BDD mutable de `(entité_1, entité_2, …)` avec des
> side effects observables via `read` sur certaines entités. »_ (spec §2)

Vercel n'expose qu'**un seul plane** côté Vaubaan : `runtime` (par contraste
avec Supabase qui en a 4). Toutes les entités vivent sous un `team`, et la
quasi-totalité sous un `project`. Les seules entités account-level sont
`team` lui-même et le `account` (porteur du PAT / Integration Bearer).

### 1.1 Graphe d'entités

```mermaid
flowchart TB
  account[account / installation]
  team[team]
  account --> team

  team --> project[project]

  %% Project-scoped governance / posture
  project --> project-settings[project-settings<br/>framework, build cmd, node version, root dir]
  project --> deployment-protection[deployment-protection<br/>SSO + password gate]
  project --> domain[domain<br/>custom DNS attachment]

  %% Project × env triad
  project --> env[env<br/>prod | preview | development]

  %% Env-scoped resources
  env --> deployment[deployment<br/>built + served instance]
  env --> env-var[env-var<br/>key/value, plain|encrypted|sensitive]

  %% Deployment-scoped artefacts
  deployment --> build-log[build-log]
  deployment --> runtime-log[runtime-log]
  deployment --> bypass-token[bypass-token<br/>protection bypass URL]
  deployment --> toolbar-thread[toolbar-thread<br/>comments + reactions]
  toolbar-thread --> toolbar-message[toolbar-message]
```

### 1.2 Cardinalités déclarées

| Path                                                                          | Cardinalité | Justification                                                                            |
| ----------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `vercel.account[*]`                                                           | `one`       | Un seul Bearer/Integration côté Vaubaan par admin row.                                   |
| `vercel.team[*]`                                                              | `bounded`   | Le PAT/Integration est team-scoped (souvent 1, parfois listé via `list_teams`).          |
| `vercel.team[X].project[*]`                                                   | `bounded`   | Liste finie par team. Le binding Vaubaan force `project ∈ bindings`.                     |
| `vercel.project[X].env[prod, preview, development]`                           | `bounded`   | Triade Vercel **fermée** (pas de "stage", pas de "qa" custom).                           |
| `vercel.project[X].env[E].deployment[*]`                                      | `unbounded` | Vercel garde l'historique complet, peut être très long.                                  |
| `vercel.project[X].env[E].env-var[*]`                                         | `bounded`   | Quota Vercel ~1000 par project.                                                          |
| `vercel.project[X].domain[*]`                                                 | `bounded`   | Quelques unités par projet en pratique.                                                  |
| `vercel.project[X].deployment-protection`                                     | `one`       | Une seule config par projet (ssoProtection + passwordProtection comme deux sous-champs). |
| `vercel.project[X].project-settings`                                          | `one`       | Singleton par projet (framework, build cmd, node version, …).                            |
| `vercel.project[X].env[E].deployment[D].toolbar-thread[*]`                    | `bounded`   | Threads de feedback toolbar, ~dizaines.                                                  |
| `vercel.project[X].env[E].deployment[D].toolbar-thread[T].toolbar-message[*]` | `bounded`   | Réponses dans un thread.                                                                 |
| `vercel.project[X].env[E].deployment[D].bypass-token[*]`                      | `bounded`   | Token TTL court généré on-demand pour bypass de la deployment-protection.                |
| `vercel.project[X].env[E].deployment[D].build-log`                            | `one`       | Stream/blob unique par deployment.                                                       |
| `vercel.project[X].env[E].deployment[D].runtime-log`                          | `unbounded` | Stream de lignes, filtrable par `since/until/level/source/requestId`.                    |

### 1.3 Containment vs ce que `classify.ts` voit aujourd'hui

Le classifier actuel collapse beaucoup d'entités sous 4 levels
(`account`, `project-settings`, `deployment`, `config`). Le data-model v4
en distingue **8** (account, team, project, env, deployment, env-var,
domain, deployment-protection, project-settings, toolbar-thread/-message,
build-log, runtime-log, bypass-token), ce qui permet au catalogue de risks
de discriminer finement :

- `deployment.W[target=prod]` ≠ `domain.W` (un est runtime, l'autre est DNS
  posture-shift externe).
- `env-var.W[secret]` ≠ `project-settings.W[framework]` (un est secret, l'autre
  est métadonnée de build).
- `toolbar-thread.W` (commentaire UI) ≠ `deployment.W` (trigger build).

### 1.4 Side effects observables via `read`

Certains reads ne sont **pas inertes** au sens HTTP :

- `vercel__get_access_to_vercel_url` → **génère un bypass-token** (crée une
  ressource). Sémantiquement c'est un `bypass-token.W` même si l'API est un
  GET → à classifier `W`, pas `R` (cf. §5 edge cases).
- `vercel__web_fetch_vercel_url` → fait un HTTP fetch sortant (side effect
  externe : log d'accès côté target, potentiellement coût bande passante).

Tous les autres reads sont vraiment des reads.

---

## 2. Mapping tool → slice(s)

27 tools exposés. La colonne **slice** suit le DSL spec v4 §3. La colonne
**env-resolution** indique comment l'env est résolu au call (`static` =
env-less ; `runtime` = depuis `args.target`). La colonne **fan-out** signale
les cas où une seule invocation touche plusieurs envs (cf. risk
`vercel.env-var-fan-out`).

### 2.1 Reads (15 tools)

| Tool                                               | Slice (pattern catalogue)                                                 | Env-resolution | Fan-out |
| -------------------------------------------------- | ------------------------------------------------------------------------- | -------------- | ------- |
| `vercel__search_vercel_documentation`              | `vercel.account[*].docs.R`                                                | n/a            | —       |
| `vercel__list_teams`                               | `vercel.account[*].team[*].R`                                             | n/a            | —       |
| `vercel__list_projects`                            | `vercel.team[T].project[*].R`                                             | n/a            | —       |
| `vercel__get_project`                              | `vercel.project[P].project-settings.R`                                    | n/a            | —       |
| `vercel__list_project_domains` _(custom)_          | `vercel.project[P].domain[*].R`                                           | n/a            | —       |
| `vercel__check_domain_availability_and_price`      | `vercel.account[*].registrar.R` (lookup public)                           | n/a            | —       |
| `vercel__list_deployments`                         | `vercel.project[P].env[*].deployment[*].R`                                | n/a            | —       |
| `vercel__get_deployment`                           | `vercel.project[P].env[E].deployment[D].R`                                | static         | —       |
| `vercel__get_deployment_build_logs`                | `vercel.project[P].env[E].deployment[D].build-log.R`                      | static         | —       |
| `vercel__get_runtime_logs`                         | `vercel.project[P].env[E].deployment[D].runtime-log.R`                    | static         | —       |
| `vercel__web_fetch_vercel_url`                     | `vercel.project[P].env[E].deployment[D].R` (+ external fetch side-effect) | static         | —       |
| `vercel__list_toolbar_threads`                     | `vercel.project[P].env[E].deployment[D].toolbar-thread[*].R`              | static         | —       |
| `vercel__get_toolbar_thread`                       | `vercel.project[P].env[E].deployment[D].toolbar-thread[T].R`              | static         | —       |
| `vercel__list_env_vars` _(custom)_                 | `vercel.project[P].env-var[*].R`                                          | static         | —       |
| `vercel__list_env_vars` _(custom, `decrypt=true`)_ | `vercel.project[P].env-var[*].R[plaintext]` (sous-cas)                    | static         | —       |

### 2.2 Writes (12 tools)

| Tool                                              | Slice (pattern catalogue)                                                       | Env-resolution                                 | Fan-out                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ | ------------------ | --------------------------------------------- |
| `vercel__deploy_to_vercel`                        | `vercel.project[P].env[target].deployment.W`                                    | `runtime` (`args.target` → `prod               | preview                                          | development`)      | Non — 1 env                                   |
| `vercel__get_access_to_vercel_url`                | `vercel.project[P].env[E].deployment[D].bypass-token.W`                         | static (héritage de la deployment)             | Non                                              |
| `vercel__upsert_env_var` _(custom)_               | `vercel.project[P].env[target ∈ array].env-var[KEY].W`                          | `runtime` (`args.target: ('prod'               | 'preview'                                        | 'development')[]`) | **Oui** — `target` array, par défaut = 3 envs |
| `vercel__delete_env_var` _(custom)_               | `vercel.project[P].env[target].env-var[ID].W` (delete)                          | `runtime` (`args.target`, défaut `production`) | Non (delete unique côté API mais hint d'env)     |
| `vercel__update_project_settings` _(custom)_      | `vercel.project[P].project-settings.W`                                          | static                                         | Implicite — affecte les builds futurs des 3 envs |
| `vercel__update_deployment_protection` _(custom)_ | `vercel.project[P].deployment-protection.W`                                     | static                                         | Implicite — affecte la posture cross-env         |
| `vercel__add_project_domain` _(custom)_           | `vercel.project[P].domain[NAME].W` (+ DNS posture-shift externe)                | static                                         | Non                                              |
| `vercel__verify_project_domain` _(custom)_        | `vercel.project[P].domain[NAME].W` (re-check, pas d'écriture nouvelle)          | static                                         | Non                                              |
| `vercel__remove_project_domain` _(custom)_        | `vercel.project[P].domain[NAME].W` (delete)                                     | static                                         | Non                                              |
| `vercel__change_toolbar_thread_resolve_status`    | `vercel.project[P].env[E].deployment[D].toolbar-thread[T].W`                    | static                                         | Non                                              |
| `vercel__reply_to_toolbar_thread`                 | `vercel.project[P].env[E].deployment[D].toolbar-thread[T].toolbar-message.W`    | static                                         | Non                                              |
| `vercel__edit_toolbar_message`                    | `vercel.project[P].env[E].deployment[D].toolbar-thread[T].toolbar-message[M].W` | static                                         | Non                                              |
| `vercel__add_toolbar_reaction`                    | `vercel.project[P].env[E].deployment[D].toolbar-thread[T].toolbar-message[M].W` | static                                         | Non                                              |

### 2.3 Notes sur l'env-resolution

- **`deploy_to_vercel`** : `args.target` est un scalaire optionnel. Classifier
  actuel défaute à `prod` quand absent — **conservateur correct**, on garde.
- **`upsert_env_var`** : `args.target` est un **array** `('production' |
'preview' | 'development')[]`. Absent → Vercel applique aux 3 envs (cf.
  `custom-tools.ts:99-107`). Le classifier actuel ne traite que le scalaire
  → **bug latent v1** à corriger en v4 : émettre **une slice par env du
  target array**, ce qui force le risk `vercel.env-var-fan-out` si > 1 env
  ou si l'array contient `production`.
- **`delete_env_var`** : `args.target` est un scalaire (hint Vaubaan, pas
  consommé par l'API Vercel). Défaut `production` (conservateur).
- **Tools toolbar** : env-less côté actuel mais l'env est résolvable depuis
  le `deployment.id` (sous-jacent à la thread). En v4 on garde env-less pour
  simplicité — risque déjà faible (cf. §3).

---

## 3. Catalogue de risks YAML

12 entrées + 1 fallback. RiskId qualifié par binding via convention
`vercel[<env>].<name>` quand env-scoped, `vercel.<name>` sinon
(spec §4.4 + §16 Q2).

```yaml
vercel:
  risks:
    # ─── READS ─────────────────────────────────────────────────────────────

    - id: vercel.read-account
      label: 'Lire account/team/project metadata'
      reason: "Inventaire des projects/teams/deployments. Aucune mutation,
        metadata non-secret. Surface d'attaque négligeable."
      matches: 'vercel.{account,team,project}[**].R'
      vector:
        reversibility: reversible
        blast: single
        data: metadata
        cost: free
        visibility: internal
        persistence: stateless

    - id: vercel.read-deployment
      label: 'Lire deployments + build/runtime logs'
      reason: "Logs runtime peuvent contenir des données applicatives (PII si
        l'app les log par accident, OWASP LLM01 via tokens injectés
        dans les logs). Mais c'est la posture standard d'un coding
        agent en debug."
      matches: 'vercel.project[**].env[**].deployment[**].{R,build-log.R,runtime-log.R}'
      vector:
        reversibility: reversible
        blast: single
        data: data
        cost: free
        visibility: internal
        persistence: stateless

    - id: vercel.read-env-var
      label: 'Lire les env vars (sans plaintext)'
      reason: "Lecture des clés et valeurs encryptées. Pas d'exfil directe
        possible — les valeurs renvoyées sont chiffrées par Vercel."
      matches: 'vercel.project[**].env-var[**].R'
      vector:
        reversibility: reversible
        blast: single
        data: metadata
        cost: free
        visibility: internal
        persistence: stateless

    - id: vercel.read-env-var-plaintext
      label: 'Lire les env vars en clair (decrypt=true)'
      reason: "Exfil directe possible des secrets prod (Stripe key, DB url,
        JWT signing key…) si l'agent a ce risk. Equivalent à une
        compromission complète des credentials prod."
      matches: 'vercel.project[**].env-var[**].R[plaintext]'
      vector:
        reversibility: reversible
        blast: account
        data: secret
        cost: free
        visibility: internal
        persistence: stateless

    - id: vercel.fetch-deployment-url
      label: 'Fetch HTTP vers une deployment URL'
      reason: "Side effect externe : log d'accès côté target, potentielle
        consommation de bande passante. Pas un risque sécu majeur
        mais à tracer."
      matches: 'vercel.project[**].env[**].deployment[**].R'
      vector:
        reversibility: reversible
        blast: single
        data: data
        cost: free
        visibility: public
        persistence: stateless

    - id: vercel.mint-bypass-token
      label: 'Minter un token de bypass de deployment protection'
      reason: 'Credential creation. Le token contourne la SSO/Password Gate
        sur une URL de deployment. TTL court mais exposable hors-bande.'
      matches: 'vercel.project[**].env[**].deployment[**].bypass-token.W'
      vector:
        reversibility: reversible
        blast: single
        data: secret
        cost: free
        visibility: internal
        persistence: session

    # ─── WRITES — DEPLOYMENT ───────────────────────────────────────────────

    - id: vercel.deploy-preview
      label: 'Déclencher un deploy preview'
      reason: "Pas d'impact prod. Build sur infra Vercel, URL non-indexée.
        Reversible (les builds preview expirent ou peuvent être
        supprimés)."
      matches: 'vercel.project[**].env[preview,development].deployment.W'
      vector:
        reversibility: reversible
        blast: single
        data: data
        cost: moderate
        visibility: team
        persistence: session

    - id: vercel.deploy-prod
      label: 'Déclencher un deploy prod'
      reason: 'Public, costly à rollback (alias prod re-pointé, cache CDN
        invalidé, communications/release notes en aval). Effet
        immédiat sur les visiteurs.'
      matches: 'vercel.project[**].env[prod].deployment.W'
      vector:
        reversibility: costly
        blast: env
        data: data
        cost: moderate
        visibility: public
        persistence: session

    # ─── WRITES — TOOLBAR (low-risk feedback comments) ─────────────────────

    - id: vercel.toolbar-write
      label: 'Écrire / éditer / réagir sur les toolbar threads'
      reason: 'Commentaires UI sur deployment preview. Visible team-only,
        réversible par delete/edit, aucune incidence sur build/runtime.
        Mutate sémantiquement, mais risque minimal.'
      matches: 'vercel.project[**].env[**].deployment[**].toolbar-thread[**].**.W'
      vector:
        reversibility: reversible
        blast: single
        data: data
        cost: free
        visibility: team
        persistence: session

    # ─── WRITES — ENV VARS (secrets) ───────────────────────────────────────

    - id: vercel.env-var-write-preview
      label: 'Écrire un env var preview/development'
      reason: "Affecte les builds preview/dev futurs. Pas d'impact prod direct.
        Mais valeur stockée = secret côté Vercel."
      matches: 'vercel.project[**].env[preview,development].env-var[**].W'
      vector:
        reversibility: reversible
        blast: env
        data: secret
        cost: free
        visibility: internal
        persistence: posture

    - id: vercel.env-var-write-prod
      label: 'Écrire un env var prod'
      reason: "Posture-shift sur les credentials prod (DB url, JWT secret,
        API keys). Une valeur erronée peut casser le service au
        prochain deploy. Une valeur attacker-injectée peut exfiltrer
        le trafic ou prendre le contrôle de l'app."
      matches: 'vercel.project[**].env[prod].env-var[**].W'
      vector:
        reversibility: costly
        blast: env
        data: secret
        cost: free
        visibility: internal
        persistence: posture

    - id: vercel.env-var-fan-out
      label: 'Écrire un env var sur tous les envs (prod inclus)'
      reason: "`upsert_env_var target=['production','preview','development']`
        ou target omis → écriture **simultanée** sur les 3 envs. Élève
        une erreur preview-only à un incident prod. Risk distinct du
        write env-par-env."
      matches: 'vercel.project[**].env[*,*,*].env-var[**].W'
      vector:
        reversibility: costly
        blast: bulk
        data: secret
        cost: free
        visibility: internal
        persistence: posture

    # ─── WRITES — PROJECT SETTINGS (build pipeline) ────────────────────────

    - id: vercel.project-settings-write
      label: 'Modifier project settings (framework, build cmd, node version, root dir)'
      reason: 'Affecte le pipeline de build de **toutes** les futures
        deployments des 3 envs. Une mauvaise install/build command
        peut casser preview ET prod au prochain push. Posture-shift
        sur la chaîne CI.'
      matches: 'vercel.project[**].project-settings.W'
      vector:
        reversibility: costly
        blast: account
        data: metadata
        cost: free
        visibility: internal
        persistence: posture

    # ─── WRITES — DEPLOYMENT PROTECTION (governance) ───────────────────────

    - id: vercel.deployment-protection-write
      label: 'Activer / désactiver / configurer la deployment protection (SSO + password)'
      reason: "Gouvernance d'accès aux deployments. Disabler la protection
        expose une preview qui était interne. Modifier le mot de passe
        casse les accès humains existants. Posture-shift externe."
      matches: 'vercel.project[**].deployment-protection.W'
      vector:
        reversibility: reversible
        blast: account
        data: secret
        cost: free
        visibility: team
        persistence: posture

    # ─── WRITES — DOMAINS (DNS posture-shift externe) ──────────────────────

    - id: vercel.domain-write
      label: 'Attacher / détacher / vérifier un domaine custom'
      reason: "Couplage DNS externe. Add → routing public (peut détourner
        trafic d'un domaine sous notre contrôle). Remove → casse le
        service public si c'est le domaine prod. Verify → réversible
        et inoffensif, mais inclus pour homogénéité."
      matches: 'vercel.project[**].domain[**].W'
      vector:
        reversibility: costly
        blast: account
        data: metadata
        cost: free
        visibility: public
        persistence: posture

    # ─── FALLBACK générique (DOIT être présent) ────────────────────────────

    - id: vercel.uncategorized-write
      label: 'Écriture Vercel non catégorisée'
      reason: "Catch-all pour les writes qui n'ont pas été explicitement
        catégorisés. Si vu en prod, signale qu'il manque une entrée
        au catalogue."
      matches: 'vercel.**.W'
      vector:
        reversibility: costly
        blast: env
        data: data
        cost: free
        visibility: internal
        persistence: session
```

### 3.1 `acceptable_in_envs` (spec v4 §4.1, §16 Q5)

Risques pour lesquels accepter en prod n'a structurellement pas de sens :

- `vercel.env-var-write-preview` → `acceptable_in_envs: ['preview', 'development']`
  (par construction, la cible env est dans le risk-id).

Les autres risks sont soit account-scoped (`project-settings`, `domain`,
`deployment-protection`) et donc non env-qualifiables, soit déjà qualifiés
par env dans le RiskId (`deploy-preview` vs `deploy-prod`,
`env-var-write-preview` vs `env-var-write-prod`).

---

## 4. Lint coverage — matrice tool × risk

Vérifie que **chaque tool exposé** matche au moins un risk du catalogue.
Ligne = tool, colonne = risk-id matché. ✓ = match direct, (✓) = match via
fallback uniquement (signal de risk manquant).

### 4.1 Reads (15 tools)

| Tool                                          | read-account | read-deployment | read-env-var | read-env-var-plaintext | fetch-deployment-url |
| --------------------------------------------- | :----------: | :-------------: | :----------: | :--------------------: | :------------------: |
| `vercel__search_vercel_documentation`         |      ✓       |                 |              |                        |                      |
| `vercel__list_teams`                          |      ✓       |                 |              |                        |                      |
| `vercel__list_projects`                       |      ✓       |                 |              |                        |                      |
| `vercel__get_project`                         |      ✓       |                 |              |                        |                      |
| `vercel__list_project_domains`                |      ✓       |                 |              |                        |                      |
| `vercel__check_domain_availability_and_price` |      ✓       |                 |              |                        |                      |
| `vercel__list_deployments`                    |              |        ✓        |              |                        |                      |
| `vercel__get_deployment`                      |              |        ✓        |              |                        |                      |
| `vercel__get_deployment_build_logs`           |              |        ✓        |              |                        |                      |
| `vercel__get_runtime_logs`                    |              |        ✓        |              |                        |                      |
| `vercel__web_fetch_vercel_url`                |              |                 |              |                        |          ✓           |
| `vercel__list_toolbar_threads`                |              |        ✓        |              |                        |                      |
| `vercel__get_toolbar_thread`                  |              |        ✓        |              |                        |                      |
| `vercel__list_env_vars` (decrypt=false)       |              |                 |      ✓       |                        |                      |
| `vercel__list_env_vars` (decrypt=true)        |              |                 |      ✓       |           ✓            |                      |

### 4.2 Writes (12 tools)

| Tool                                            | deploy-preview | deploy-prod | toolbar-write | env-var-write-preview | env-var-write-prod | env-var-fan-out | project-settings-write | deployment-protection-write | domain-write | mint-bypass-token | uncategorized (fallback) |
| ----------------------------------------------- | :------------: | :---------: | :-----------: | :-------------------: | :----------------: | :-------------: | :--------------------: | :-------------------------: | :----------: | :---------------: | :----------------------: |
| `vercel__deploy_to_vercel` (target=preview)     |       ✓        |             |               |                       |                    |                 |                        |                             |              |                   |                          |
| `vercel__deploy_to_vercel` (target=prod)        |                |      ✓      |               |                       |                    |                 |                        |                             |              |                   |                          |
| `vercel__deploy_to_vercel` (target=development) |       ✓        |             |               |                       |                    |                 |                        |                             |              |                   |                          |
| `vercel__upsert_env_var` (target=[preview])     |                |             |               |           ✓           |                    |                 |                        |                             |              |                   |                          |
| `vercel__upsert_env_var` (target=[production])  |                |             |               |                       |         ✓          |                 |                        |                             |              |                   |                          |
| `vercel__upsert_env_var` (target=all 3 / omis)  |                |             |               |           ✓           |         ✓          |        ✓        |                        |                             |              |                   |                          |
| `vercel__delete_env_var` (target=preview)       |                |             |               |           ✓           |                    |                 |                        |                             |              |                   |                          |
| `vercel__delete_env_var` (target=production)    |                |             |               |                       |         ✓          |                 |                        |                             |              |                   |                          |
| `vercel__update_project_settings`               |                |             |               |                       |                    |                 |           ✓            |                             |              |                   |                          |
| `vercel__update_deployment_protection`          |                |             |               |                       |                    |                 |                        |              ✓              |              |                   |                          |
| `vercel__add_project_domain`                    |                |             |               |                       |                    |                 |                        |                             |      ✓       |                   |                          |
| `vercel__verify_project_domain`                 |                |             |               |                       |                    |                 |                        |                             |      ✓       |                   |                          |
| `vercel__remove_project_domain`                 |                |             |               |                       |                    |                 |                        |                             |      ✓       |                   |                          |
| `vercel__get_access_to_vercel_url`              |                |             |               |                       |                    |                 |                        |                             |              |         ✓         |                          |
| `vercel__change_toolbar_thread_resolve_status`  |                |             |       ✓       |                       |                    |                 |                        |                             |              |                   |                          |
| `vercel__reply_to_toolbar_thread`               |                |             |       ✓       |                       |                    |                 |                        |                             |              |                   |                          |
| `vercel__edit_toolbar_message`                  |                |             |       ✓       |                       |                    |                 |                        |                             |              |                   |                          |
| `vercel__add_toolbar_reaction`                  |                |             |       ✓       |                       |                    |                 |                        |                             |              |                   |                          |

**Résultat lint** : 0 tool tombe uniquement dans le fallback. Le fallback
`vercel.uncategorized-write` reste néanmoins **obligatoire** (spec §14 anti-
pattern "catalogue avec trous") pour les futurs tools non-encore-catégorisés
introduits par le rewrap.

### 4.3 Cas multi-slice signalé par le mapping

Trois tools émettent **plusieurs slices** ou **plusieurs risks_touched** :

1. **`vercel__upsert_env_var` avec `target=['production','preview','development']`**
   (ou target omis) → émet 3 slices `vercel.project[P].env[E].env-var[KEY].W`
   (une par env), donc touche `env-var-write-preview` ET `env-var-write-prod`
   ET `env-var-fan-out`. Le token doit avoir accepté les 3 risks pour
   passer.

2. **`vercel__get_access_to_vercel_url`** → émet `bypass-token.W` (risk
   `mint-bypass-token`). Vérifier que le classifier émet bien un `W` ici et
   pas un `R` (cf. §5 edge case).

3. **`vercel__update_deployment_protection`** → écrit un password (champ
   `passwordProtection.password`) + un toggle SSO. Le risk
   `deployment-protection-write` a `data: secret` pour cette raison.

---

## 5. Edge cases — décisions à acter

### 5.1 `vercel__update_deployment_protection` — `govern` ou `mutate` ?

C'est **clairement governance** (control de l'accès aux deployments). En v4
on n'a plus de macro `govern`, mais le risk dédié
`vercel.deployment-protection-write` porte la sémantique via son vecteur :

- `persistence: posture` (changement durable).
- `data: secret` (le password EST stocké).

**Décision proposée** : risk distinct. Aligne le traitement avec
`branch-protection-write` côté GitHub.

### 5.2 `vercel__add_project_domain` — DNS = posture-shift externe

Le risk `vercel.domain-write` couvre add/verify/remove. Les 3 sous-tools ont
des sémantiques **différentes** :

- `add` → attache un domaine, peut router publiquement vers le projet (si
  les DNS pointent déjà). Si l'attacker a déjà compromis le DNS de
  `victim.com`, attacher `victim.com` au projet permet du **bait-and-switch**.
- `verify` → re-déclenche la vérification, **inoffensif** (idempotent, pas
  de mutation côté Vercel).
- `remove` → casse le service public si c'est le domaine prod.

**Option A** : un seul risk `vercel.domain-write` (proposé ci-dessus).
Simple, cohérent.
**Option B** : 3 risks (`domain-add`, `domain-verify`, `domain-remove`).
Permet d'accepter `verify` sans le reste.

**Décision proposée** : **Option A** au MVP. `verify` est rarement utile
isolément (on l'appelle juste après `add`). Si l'usage montre un besoin de
granularité, splitter en Phase 2.

### 5.3 Tools custom vs natifs Vercel — risk distinct ?

Les 9 tools custom REST (`add_project_domain`, `verify_project_domain`,
`update_deployment_protection`, `update_project_settings`, `upsert_env_var`,
`list_env_vars`, `delete_env_var`, `list_project_domains`,
`remove_project_domain`) sont des **augmentations sur des trous du MCP
officiel**, pas des opérations sémantiquement différentes.

**Décision** : **pas de distinction risk-side** entre custom et natif.
Le risk porte l'intention métier ("écrire un env var prod"), pas la
plomberie d'implémentation (REST vs JSON-RPC forward).

Conséquence : le risk-catalog reste stable même si Vercel finit par exposer
nativement `upsert_env_var` côté MCP (cf. ADR `vercel-augment-with-rest-tools`
§ conditions de bascule).

### 5.4 `vercel__get_access_to_vercel_url` — read ou write ?

L'API est un GET mais **crée une ressource** (bypass-token) avec TTL court.
Classifier actuel le marque `read-deployment` → **bug latent**, sous-classifié.

**Décision proposée** : reclassifier `bypass-token.W`, matche
`vercel.mint-bypass-token`. Le coding agent qui veut juste "lire les logs"
n'en a pas besoin ; celui qui veut "partager une preview avec un client
en bypass de la SSO" en a besoin et c'est un acte distinct.

### 5.5 `vercel__web_fetch_vercel_url` — risk dédié ?

Le tool fait un HTTP fetch sortant vers une URL Vercel. Side effects :
log d'accès côté target + consommation bande passante. Pas un risque sécu
majeur (l'agent peut faire la même chose via `fetch()` côté son sandbox),
mais on a un risk dédié `vercel.fetch-deployment-url` pour la traçabilité.

**Décision** : conserver le risk dédié. Permet à l'audit log de voir
précisément quelles URLs ont été fetched par l'agent.

### 5.6 Toolbar — `mutate` ou `inspect` ?

Les 4 tools toolbar (`reply`, `edit`, `react`, `resolve`) sont
sémantiquement **mutate** (créent/modifient des commentaires) mais le risk
est **très faible** (texte UI sur preview, pas d'incidence build/runtime).

**Décision** : risk distinct `vercel.toolbar-write`. Permet à un coding
agent d'interagir avec des reviewers humains sur les preview sans devoir
grant un risk plus large.

### 5.7 `list_env_vars decrypt=true` — risk dédié ?

Le param `decrypt` du tool `list_env_vars` change radicalement la classe
de risque : sans → metadata ; avec → exfil de secrets.

**Décision proposée** : **deux risks distincts**
(`read-env-var` et `read-env-var-plaintext`), discriminés au classify par
inspection de `args.decrypt === true`. Émettre les 2 slices quand
`decrypt=true`.

### 5.8 `delete_env_var` — env hint vs réalité Vercel

`args.target` côté `delete_env_var` est un **hint Vaubaan**, pas consommé
par l'API Vercel (le delete enlève le var de tous ses envs d'un coup).

**Conséquence** : si l'agent passe `target='preview'` mais que le var était
défini sur prod aussi, le delete supprime aussi sur prod sans déclencher
`env-var-write-prod`. **Bug de safety**.

**Décision proposée** : le classifier doit **émettre la slice sur les 3
envs** (`env[*]`) au lieu de honorer `args.target`. Force le risk
`env-var-fan-out` à se déclencher — le token devra avoir accepté ce
risk explicitement.

---

## 6. Trous identifiés

### 6.1 Trous data-model

| Manque                         | Impact                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firewall` (WAF rules)         | Vercel expose des Firewall rules depuis 2025 (rules par projet, IP blocking, custom challenges). Non couvert par le wrap actuel ni par le data-model. À ajouter si on expose ces tools en v2. |
| `edge-config`                  | Volontairement hors-scope (handbook §Concepts non-supportés). Pas de risk catalogue dédié — si un jour exposé, risk `edge-config-write` à ajouter (posture).                                  |
| `log-drain`                    | Hors-scope. Si exposé : risk `log-drain-write` (data flow externe, `data: data`, `visibility: public`, `persistence: posture`).                                                               |
| `webhook`                      | Hors-scope. Si exposé : risk `webhook-write` (data flow externe).                                                                                                                             |
| `alias` (custom alias mapping) | Sous-cas de `deployment` côté Vercel (un alias re-mappe le DNS d'un domaine vers une deployment précise). Si exposé, à modéliser comme entité `alias` sous `domain`.                          |
| `marketplace billing`          | Hors-scope (Vaubaan n'est pas une Marketplace listing).                                                                                                                                       |

### 6.2 Trous catalogue

Tous les tools sont catégorisés. Aucun tombe dans `vercel.uncategorized-
write` au mapping actuel. Le fallback reste présent **pour le futur**.

### 6.3 Bugs latents du classifier v1 à corriger en v4

1. `vercel__upsert_env_var` ne traite que le scalaire `target` → doit
   itérer sur l'array et émettre une slice par env.
2. `vercel__delete_env_var` honore `args.target` comme hint → doit émettre
   sur les 3 envs (la réalité de l'API Vercel).
3. `vercel__get_access_to_vercel_url` classifié `read-deployment` → doit
   être `bypass-token.W` (mint credential).
4. `vercel__list_env_vars` ne discrimine pas `decrypt=true` → doit émettre
   une slice supplémentaire `env-var[**].R[plaintext]` dans ce cas.

### 6.4 Décisions résiduelles à acter (avant code)

- **D1** — Adopter Option A (un seul risk `domain-write`) ou Option B
  (3 risks `add/verify/remove`) ? Proposition : A.
- **D3** — `read-env-var-plaintext` : risk distinct (proposé) ou bloquer le
  `decrypt=true` à la source (retirer le param du tool) ? Proposition :
  garder le risk pour préserver le cas légitime "rotation manuelle assistée".

---

## 7. Récap — mapping v1 → v4 pour ce provider

| Aspect classifier                  | v1 actuel (`classify.ts`)                                 | v4 proposé                                                                              |
| ---------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Sortie                             | `{ capability: {plane, level, action, env?} }`            | `{ slices: Slice[] }` (multi-slice quand fan-out)                                       |
| Niveaux                            | 4 (`account`, `project-settings`, `deployment`, `config`) | 13 entités (cf. §1.1) — plus expressif                                                  |
| Env-resolution                     | `static` ou `runtime` selon kind                          | identique, étendu pour gérer `target: string[]` (fan-out)                               |
| `upsert_env_var target=[3 envs]`   | 1 capability `config:write@prod` (perd preview+dev)       | 3 slices + risk `env-var-fan-out`                                                       |
| `delete_env_var`                   | 1 capability `config:write@<hint>`                        | 3 slices (env[*]) + risks `env-var-write-prod` + `env-var-write-preview`                |
| `get_access_to_vercel_url`         | `deployment:read`                                         | `bypass-token.W` → risk `mint-bypass-token`                                             |
| `list_env_vars decrypt=true`       | `config:read`                                             | 2 slices : `env-var[**].R` + `env-var[**].R[plaintext]` → risk `read-env-var-plaintext` |
| `update_project_settings`          | `project-settings:write`                                  | `project-settings.W` → risk `project-settings-write`                                    |
| `update_deployment_protection`     | `project-settings:write` (mélangé avec settings normaux)  | risk distinct `deployment-protection-write`                                             |
| `add/verify/remove_project_domain` | `project-settings:write`                                  | risk distinct `domain-write`                                                            |
| `toolbar-*` writes                 | `deployment:write` (env-less, mélangé avec deploy)        | risk distinct `toolbar-write`                                                           |
| Décision binaire                   | gates `allow/confirm/deny` côté policy                    | `risk ∈ accepted_risks` (strict-fail au runtime, ADR unified-gates-drop-confirm)        |
| Bypass impossible via              | `dispatch_workflow` retiré (côté GitHub, plus Vercel)     | identique                                                                               |

---

## Annexe — preset de risks "Coding Agent Standard" pour Vercel

Profil-type proposé pour un coding agent autonome sur un projet
`vaubaan-gateway`-like (cf. Annexe A spec v4) :

```
Bindings : vercel(prj_xxx)

Coder Vercel — risks à cocher au mint :
  ☑ vercel.read-account
  ☑ vercel.read-deployment
  ☑ vercel.read-env-var
  ☑ vercel.fetch-deployment-url
  ☑ vercel.deploy-preview
  ☑ vercel.toolbar-write
  ☐ vercel.deploy-prod
  ☐ vercel.env-var-write-preview
  ☐ vercel.mint-bypass-token
  ☐ vercel.project-settings-write
  ☐ vercel.env-var-fan-out
  ☐ vercel.read-env-var-plaintext
  ☐ vercel.env-var-write-prod
  ☐ vercel.deployment-protection-write
  ☐ vercel.domain-write
```

6 risks cochés par défaut + 9 explicites à ajouter selon la tâche. Post
drop-confirm la décision est binaire : un risk est dans
`accepted_risks` (allow) ou non (deny). Aligné avec l'UX cible spec §0.
