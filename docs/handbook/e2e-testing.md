---
title: E2E Testing — real clouds
tracks:
  - playwright.config.ts
  - packages/web/tests/e2e/real-clouds/
  - scripts/e2e-sweeper.ts
  - .github/workflows/e2e-nightly.yml
  - scripts/setup-e2e-secrets.md
last_reviewed: 2026-05-22
---

# E2E Testing — real clouds

Cloud Resource Manager ships its E2E tests under
`packages/web/tests/e2e/real-clouds/` and runs them against **real
provider APIs** (GitHub, Vercel, Supabase Cloud, Infisical). Posture
"no mock" (spec §12.3) : un E2E vert = la chaîne fonctionne en prod.

Aucun scénario E2E n'est exécuté sur les PRs : ils consomment des
creds réels et créent/détruisent de vraies ressources. Trigger:
`schedule` quotidien + `workflow_dispatch`.

## Architecture

```
playwright.config.ts            ← deux projects : `smoke` + `e2e-real-clouds`
packages/web/tests/e2e/
├── smoke.spec.ts               ← stub legacy (skip), survit pour compat
└── real-clouds/
    ├── fixtures/
    │   ├── env.ts              ← loader .env.test + GH Actions fallbacks
    │   ├── naming.ts           ← `vauban-e2e-<hash6>-<uuid8>`
    │   ├── vauban-client.ts    ← service-role admin (create user/org)
    │   ├── setup.ts            ← Playwright `test.extend` (la fixture commune)
    │   └── provider-clients/
    │       ├── github.ts       ← createRepo / deleteRepo / listE2ERepos
    │       ├── vercel.ts       ← createProject / deleteProject / listE2EProjects
    │       ├── supabase.ts     ← createProject / deleteProject / listE2EProjects
    │       └── infisical.ts    ← ping (placeholder, pas de write Phase 8)
    ├── smoke.spec.ts                       ← harness self-test
    ├── 01-register-org-resource.spec.ts    ← Phase 8 wave B (scenario §7.1)
    ├── 02-provision-via-admin.spec.ts      ← idem (§7.3)
    ├── 03-rotate-admin-mediated.spec.ts    ← idem (§7.4)
    ├── 04-export-env-project-variant.spec.ts ← idem (§7.5)
    ├── 05-rbac-member-403.spec.ts          ← idem (§3.3, §8)
    └── 06-reseal-on-member-add.spec.ts     ← idem (§4.5)

scripts/e2e-sweeper.ts          ← cron-driven orphan cleanup
.github/workflows/e2e-nightly.yml ← schedule + workflow_dispatch
scripts/setup-e2e-secrets.md    ← opérateur : GH secrets à provisionner
```

## Conventions

### Naming

Toute ressource créée par un test E2E porte le préfixe :

```
vauban-e2e-<testfile-hash6>-<run-uuid8>[-<suffix>]
```

- `testfile-hash6` : sha256 du `testInfo.file` (6 hex chars). Permet
  au sweeper de cibler une famille de tests si besoin de debug.
- `run-uuid8` : random 8 hex, unique par exécution. Garantit l'isolation.
- Le préfixe `vauban-e2e-` est l'anchor du sweeper : si un nom ne
  commence pas par là, le sweeper ne le touchera jamais.

Exemple : `vauban-e2e-a3f1c2-9b2dc714-repo`.

### Cleanup

Chaque spec se cleanup elle-même via `afterEach` :

1. `destroyChild` côté provider (e.g. `gh.deleteRepo`, `vercel.deleteProject`).
2. `DELETE /resources/:rId` côté Vauban (cascade audit row).
3. `admin.deleteOrg(org.id)` côté service-role (la fixture le fait).
4. `admin.deleteTestUser(creds.userId)` (idem).

Idempotence : la fixture ignore les erreurs cleanup (`.catch(() => undefined)`)
pour ne pas masquer l'erreur principale du test si une étape précédente
échoue. Le sweeper finit le job.

### Sweeper

`scripts/e2e-sweeper.ts` ratisse tous les providers :

```bash
npm run sweeper                  # live mode — destructeur
npm run sweeper -- --dry-run     # liste sans détruire
npm run sweeper -- --max-age-hours 48
```

- Filtre : préfixe `vauban-e2e-` + âge > `--max-age-hours` (default 24h).
  Le filtre temporel protège un run nightly en cours d'exécution.
- Exit code :
  - `0` : OK.
  - `1` : erreur fatale (auth, network).
  - `2` : au moins une suppression provider a échoué.
  - `3` : > 5 orphelins (signal de crashs E2E répétés).
- Couvre : GitHub repos, Vercel projects, Supabase projects,
  Supabase Auth users (`+e2e-…` pattern), Infisical (ping uniquement
  en Phase 8 — pas de write secret).

### Variables d'environnement

Le harness lit `.env.test` à la racine (gitignored) **ou** les
variables d'environnement directement. Les helpers résolvent dans
l'ordre :

1. `process.env[KEY]` (utile en CI où le workflow injecte les vars).
2. `.env.test` (utile en local).
3. Fallback alias (utile en CI : les secrets GH Actions ne peuvent
   pas commencer par `GITHUB_…`, donc on les renomme `VAUBAN_E2E_GH_…`).

Cf. `packages/web/tests/e2e/real-clouds/fixtures/env.ts` pour la map
exhaustive et `scripts/setup-e2e-secrets.md` pour le mapping
opérateur → GH secrets.

### ZK invariants

- Les fixtures n'écrivent **jamais** un sealed_blob clear dans les logs.
- Le test user reçoit un password fort (`e2e-<runUuid>-aA1!cloudResource`)
  qui sert aussi de passphrase de dérivation de la clé identité crypto.
- Le `admin` client (service-role) est utilisé **uniquement** pour
  bootstrap (create user, create org, delete cascade). Tout test
  métier passe par le BrowserContext authentifié — RLS reste le
  premier gate.

## Exécution

### Local

Prérequis : `.env.test` à la racine, `packages/web/.env.local` populé
(Supabase URL + anon key + service-role).

```bash
npm install
npm run test:e2e:real-clouds                  # toute la suite real-clouds
npm run test:e2e:real-clouds -- smoke         # un fichier précis
npm run test:e2e:real-clouds -- --headed      # avec UI Chromium
```

Le Next.js dev server est démarré automatiquement par Playwright
(cf. `webServer` dans `playwright.config.ts`). Si tu as déjà un
`npm run dev` actif, Playwright le réutilise (`reuseExistingServer`).

### CI nightly

Le workflow `.github/workflows/e2e-nightly.yml` tourne :

- Sur `schedule` (03:00 UTC quotidien).
- Sur `workflow_dispatch` (bouton "Run workflow" dans GH).

Il exécute deux jobs :

1. **`sweeper`** : ratisse les orphelins > 24h. Dry-run via
   `workflow_dispatch` si `live_sweep=false`.
2. **`e2e`** : `npm run build` + `playwright test --project=e2e-real-clouds`
   - archive du `playwright-report/`.

Secrets requis : voir `scripts/setup-e2e-secrets.md`. Les artefacts
du run sont disponibles 14 jours sous "Actions → e2e-nightly → run".

## Trous connus / TODO

- **Cloudflare** : hors-scope Phase 8 (pas de creds dédiés dans `.env.test`).
- **Infisical writes** : aucun scénario Phase 8 ne pousse de secret
  dans Infisical (le `secret_managers` row reste placeholder dans
  les flows testés). La méthode `listE2ESecrets` du sweeper est un
  no-op jusqu'à ce qu'un scénario futur introduise des writes.
- **Mobile** : Playwright tourne Chromium desktop uniquement.

## Références

- Spec : [`../spec/cloud-resource-manager.md`](../spec/cloud-resource-manager.md) §12.3, §12.4.
- E2E test plan : [`../tests/e2e-tests.md`](../tests/e2e-tests.md).
- CI workflow : [`../../.github/workflows/e2e-nightly.yml`](../../.github/workflows/e2e-nightly.yml).
- Sweeper : [`../../scripts/e2e-sweeper.ts`](../../scripts/e2e-sweeper.ts).
- Operator secrets setup : [`../../scripts/setup-e2e-secrets.md`](../../scripts/setup-e2e-secrets.md).
