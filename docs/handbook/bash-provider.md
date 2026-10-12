---
title: Bash provider — annotated-script dispatcher over SSH
status: current
date: 2026-06-15
tracks:
  - plugins/ssh/src/
  - apps/gateway/src/lib/bash/
  - apps/gateway/src/app/api/v1/bash-bindings/
  - apps/gateway/src/app/(app)/orgs/[slug]/projects/[project]/bash-bindings/
---

> **v4 document.** English rewrite scheduled by the v5 plan; `tracks` paths updated for the new layout.

# Bash provider — adapter setup & invocation

> **v4 risk-based catalog added — 2026-06-15.** Le pivot
> `chore(v1-drop)` a supprimé le classifier capability-based + le
> tool legacy `ssh__exec` (avec sa regex whitelist `isReadAllowed`).
> Le code expose désormais `risk-classifier.ts` (classifySshV4 → slices
> `ssh.host[X].command.R|W`), `risk-catalog.{yaml,ts}` (5 risks +
> fallback) et `data-model.ts`. Pour le data-model + risk catalog +
> tool → slice, lire le handbook v4 dédié :
> [`docs/handbook/providers/railway-ssh.md`](./providers/railway-ssh.md)
> §2.

Le provider `bash` expose un dispatcher générique : chaque _binding_ porte un
script bash annoté, et N hôtes SSH s'y rattachent comme _envs_. Le script
déclare lui-même sa surface MCP via des commentaires `# @vaubaan:` ; le
parser en dérive les tools MCP, le runner les exécute par SSH. SSH n'est
qu'un transport — c'est le binding qui définit l'identité applicative.

Le package `@vaubaan/plugin-ssh` n'a pas été renommé (continuité storage —
migration `0020_bash_provider.sql:39-46`) mais le provider slug exposé
côté MCP reste `bash` (`bash__*`).

ADR template : `docs/decisions/provider-onboarding-handbook-template.md`.

## Vue d'ensemble

Trois choix d'architecture déterminent la forme actuelle :

1. **Le binding = le script.** Une seule notion `bash_bindings` au lieu d'un
   triplet `provider/service/binding`. Le slug du binding est l'identité.
   Au runtime, `classifySshV4` émet des slices de forme
   `ssh.host[<host_slug>].command.R|W` (cf. spec
   [`gateway-risk-model.md`](../spec/gateway-risk-model.md) §3).
2. **Les hôtes sont des envs.** N rows `ssh_bindings` peuvent pointer vers un
   même `bash_binding_id` via FK (migration `0021`). Chaque `host_slug` devient
   un env dans la slice — i.e. même contrat, plusieurs cibles.
3. **Annotations dans le code.** Le contrat est porté par le bash lui-même
   (commentaires `# @vaubaan: ring=… action=…`) — pas par une config JSON
   séparée. Une seule source de vérité, versionnée avec le binding.

Le provider est typé dans `packages/shared/src/types.ts:10` :
`Provider = 'github' | 'vercel' | 'supabase' | 'railway' | 'bash'`. Le plane
par défaut est `host` ; les rings sont libres (déclarés par le script).

> **Status `/mcp`** : à ce jour le dispatcher `/mcp` n'est pas encore wiré
> pour `bash__*`. Les invocations passent par l'endpoint UI authentifié
> session (`/api/v1/bash-bindings/:id/run-tool`). Cf.
> `apps/gateway/src/lib/gateway/build.ts:251-254` pour le wiring en
> attente, et [`mcp-gateway.md`](./mcp-gateway.md) §Self-contained
> adapters pour le pattern cible.

## Comment ça marche

### Schéma DB

```
bash_bindings                                ssh_bindings
─────────────                                ────────────
id (uuid)                ←──FK bash_binding_id (uuid, nullable)
project_id                                   project_id
slug                                         host_slug (the env)
display_name                                 host_address, port, ssh_user
description                                  ssh_private_key (bytea)
bash_content (text)                          created_at, …
parsed_meta (jsonb)
parse_error (text)
created_by, created_at, updated_at
unique (project_id, slug)
```

- `bash_bindings.bash_content` est le script complet. `parsed_meta` cache
  le `ParsedScript` (le parser tourne à chaque write — pas de lazy parse au
  hot-path). `parse_error` est posé si le script est structurellement
  invalide pour que l'UI affiche l'erreur sans reparser.
- `ssh_bindings.bash_binding_id` (FK CASCADE) attache un host à son binding.
  Les colonnes `bash_content` / `parsed_meta` / `parse_error` ont été
  retirées de `ssh_bindings` par `0021` — l'info vit côté `bash_bindings`.
- Migration `0020_bash_provider.sql` introduit les colonnes `bash_content`
  côté `ssh_bindings` + backfill du runner script + drop de la table
  intermédiaire `runner_services` (cul-de-sac architectural).
- Migration `0021_bash_bindings.sql` crée la table `bash_bindings`, groupe
  les rows existantes par hash de script, déplace les colonnes script vers
  `bash_bindings`.

### Parser — `apps/gateway/src/lib/bash/parse.ts`

`parseAnnotatedBash(content)` retourne :

```ts
interface ParsedScript {
  plane: string; // default 'host', from `# @vaubaan-plane:`
  rings: string[]; // declared via `# @vaubaan-rings:`
  tools: ParsedTool[]; // one entry per annotated function
}

interface ParsedTool {
  functionName: string;
  ring: string; // must be in ParsedScript.rings
  action: 'read' | 'write';
  doc?: string;
  args: ParsedArg[];
}
```

Reconnaît trois familles d'annotations (lignes commentaire) :

| Marqueur          | Niveau   | Effet                                                   |
| ----------------- | -------- | ------------------------------------------------------- |
| `@vaubaan-plane:` | script   | Plane slug (défaut `host`).                             |
| `@vaubaan-rings:` | script   | Liste ordonnée des rings (ring 1 = premier).            |
| `@vaubaan:`       | fonction | `ring=X action=read\|write` (obligatoire pour exposer). |
| `@vaubaan-doc:`   | fonction | Description humaine (optionnelle).                      |
| `@vaubaan-arg:`   | fonction | `name type [required\|optional] [default=val]`.         |

Règles structurelles (`parse.ts:166-179`) :

- `rings` doit être déclaré (sinon `ParseError`).
- Chaque tool référence un ring qui doit être dans la liste.
- Une fonction sans bloc `# @vaubaan:` complet est traitée comme private
  helper (silencieusement ignorée).
- Au moins un tool annoté doit exister.

Tests : 11 unit tests dans `parse.test.ts` (happy path + chaque branche de
rejet + branches d'argument typing).

### Runner — `apps/gateway/src/lib/bash/{exec,args,exec-host}.ts`

`buildToolInvocation(bashContent, functionName, args)` (`exec.ts:18`) produit
une ligne shell `cmd` :

```sh
echo '<base64-encoded body>' | base64 -d | bash -s -- 'arg1' 'arg2'
```

- Le _body_ = `bashContent\n<functionName> "$@"\n` ; encodé en base64 pour
  s'affranchir de tout problème de quoting / heredoc.
- Les args sont POSIX-quotés (`shellQuote` ligne 34-38) puis passés via
  `bash -s --` comme positionnels.
- `base64 -d` (GNU coreutils) est supposé présent sur tout Linux.

Tests : 4 unit tests dans `exec.test.ts` (échappement single-quote, args
vides, content multi-ligne, intégration `parse → build`).

Deux helpers complémentaires partagent la logique entre routes REST :

- `materializeArgs(tool, raw)` (`args.ts:29`) — convertit la map
  `{ name: value }` en `argv: string[]` positionnel, en respectant les
  contraintes du parser (required / optional / default). Retourne un
  discriminated union `{ ok, argv } | { ok: false, error }`. La même
  logique sera réutilisée par le dispatch `/mcp` futur.
- `loadHostByIdInOrg` / `loadHostBySlugInOrg` + `execOnHost`
  (`exec-host.ts`) — centralisent le check org-scope + bytea→PEM decode +
  `sshExec` pour `run-tool` et le smoke `/test`. Évite de dupliquer un
  chemin authz-sensible.

### SSH transport — `plugins/ssh/src/`

Le package `@vaubaan/plugin-ssh` fournit le client SSH brut + le
risk classifier v4 :

- `sshExec(binding, cmd, timeout_s)` → `ExecResult` (stdout / stderr /
  exit_code / duration_ms / truncated). Implémenté sur `ssh2` (lib npm).
  Limites : `MAX_STDOUT_BYTES = 1 MiB`, `MAX_TIMEOUT_S = 300`
  (`execute.ts:18-19`).
- `humanizeConnError(err)` (`execute.ts:21-33`) reformule
  `ECONNREFUSED`/`Authentication`/`ETIMEDOUT` en messages opérateur lisibles.
- `classifySshV4(tool, args, bindings)` (`risk-classifier.ts`) émet des
  slices `ssh.host[X].command.R|W` consommées par
  `@vaubaan/policy-engine`. Voir
  [`providers/railway-ssh.md`](./providers/railway-ssh.md) §2 pour le
  data-model + risk catalog + mapping tool → slice.

### API REST — `/api/v1/bash-bindings/...`

5 routes, toutes en runtime nodejs + `force-dynamic`, gardées par
`requireOrgMember` (session) :

| Méthode | Path                                                  | Effet                                                                                |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| GET     | `/api/v1/bash-bindings?orgSlug=&projectSlug=`         | Liste les bindings d'un projet.                                                      |
| POST    | `/api/v1/bash-bindings`                               | Crée un binding (script optionnel).                                                  |
| GET     | `/api/v1/bash-bindings/:bindingId?orgSlug=`           | Détail d'un binding (avec `bash_content`).                                           |
| PATCH   | `/api/v1/bash-bindings/:bindingId`                    | Maj `display_name` / `description` / `bash_content`. Re-parse + 400 si `ParseError`. |
| DELETE  | `/api/v1/bash-bindings/:bindingId?orgSlug=`           | Supprime le binding (cascade sur hosts).                                             |
| GET     | `/api/v1/bash-bindings/:bindingId/hosts`              | Liste les hôtes attachés.                                                            |
| POST    | `/api/v1/bash-bindings/:bindingId/hosts`              | Attache un nouvel hôte (génère ou accepte une clé).                                  |
| DELETE  | `/api/v1/bash-bindings/:bindingId/hosts/:hostId`      | Détache un hôte.                                                                     |
| POST    | `/api/v1/bash-bindings/:bindingId/hosts/:hostId/test` | Smoke test (`uptime`) sur l'hôte.                                                    |
| POST    | `/api/v1/bash-bindings/:bindingId/run-tool`           | Invoque un tool sur un hôte (cf. flow ci-dessous).                                   |

Création d'hôte (`hosts/route.ts:99-117`) : si `generate_key: true`, génère
une paire `ed25519` et retourne la clé publique OpenSSH dans la réponse
(à coller dans `~/.ssh/authorized_keys` côté host). Sinon, accepte un
`ssh_private_key_pem` fourni.

### Flow d'invocation — `run-tool/route.ts`

```
POST /api/v1/bash-bindings/:bindingId/run-tool
  { orgSlug, host_slug, tool, args, timeout_s? }
  │
  ├─ requireOrgMember(orgSlug)
  ├─ load bash_bindings(:bindingId) + check org match
  ├─ if !bash_content || !parsed_meta → 400 "no script"
  ├─ tool = parsed_meta.tools.find(t => t.functionName === body.tool)
  ├─ materializeArgs(tool, body.args) → argv | { error }
  ├─ loadHostBySlugInOrg(bindingId, host_slug) → host (org-scoped)
  ├─ cmd = buildToolInvocation(bash_content, tool.functionName, argv)
  ├─ execOnHost(host, cmd, timeout_s) → { stdout, stderr, exit_code, ... }
  └─ writeRestBypassAudit(svc, { ... }) — fire-and-forget audit row
```

L'endpoint **bypass le moteur policy** mais **écrit un audit_log** :
chaque appel produit une row `decision='allowed'`,
`tool_name='bash__rest__<fn>'`, et `denial_reason='rest-bypass'`
(marker grep-able pour identifier les rows qui n'ont pas traversé la
pipeline `/mcp` policy). Implémenté par `writeRestBypassAudit` (route
ligne 64). Helper temporaire — drop quand le dispatch `/mcp` per-binding
lande (TODO marker `TODO(bash-mcp-wiring)` ligne 47). Cf.
`build.ts:251-254` pour le wiring gateway en attente.

### UI — `bash-bindings/[bindingId]/`

Page détail composée de trois cards :

- `script-card.tsx` — éditeur du `bash_content`, surfaces `parsed_meta`
  (rings, tools, args) et `parse_error`.
- `hosts-card.tsx` — liste des hosts attachés, formulaire d'ajout
  (genkey ou clé fournie), bouton _Test_ par host.
- `runner-card.tsx` — sélecteur host × tool × args, affiche le résultat de
  l'invocation (stdout / stderr / exit_code).

Le path `orgs/:slug/projects/:project/bash/` est un redirect vers
`bindings/new` (composer existant — `bash/page.tsx`).

## Comment l'utiliser

### Écrire un script annoté

```sh
#!/usr/bin/env bash
# @vaubaan-plane: host
# @vaubaan-rings: process logs

# @vaubaan: ring=process action=read
# @vaubaan-doc: Status du daemon.
my_status() {
  systemctl status my-service --no-pager
}

# @vaubaan: ring=logs action=read
# @vaubaan-doc: Dernières N lignes de log.
# @vaubaan-arg: lines integer optional default=100
my_logs() {
  local n="${1:-100}"
  journalctl -u my-service -n "$n" --no-pager
}

# @vaubaan: ring=process action=write
# @vaubaan-doc: Redémarre le daemon.
my_restart() {
  sudo systemctl restart my-service
}
```

Tools MCP générés (attachés à 1+ host_slug — disons `prod-1`) :

- `bash__<binding_slug>__my_status` → ring `process`, action `R`
- `bash__<binding_slug>__my_logs` → ring `logs`, action `R`
- `bash__<binding_slug>__my_restart` → ring `process`, action `W`

Au call, `classifySshV4` émet une slice par invocation (forme
`ssh.host[prod-1].command.R|W`) et le runtime intersecte avec le risk
catalog SSH (cf. [`providers/railway-ssh.md`](./providers/railway-ssh.md) §2).

### Créer un binding + host via API

```bash
# 1. Créer le binding (script optionnel à l'init)
curl -X POST https://vaubaan.com/api/v1/bash-bindings \
  -H "Cookie: $SESSION" -H "Content-Type: application/json" \
  -d '{
    "orgSlug": "acme",
    "projectSlug": "ops",
    "slug": "my-service",
    "display_name": "My service",
    "bash_content": "..."
  }'

# 2. Attacher un host (génère une clé ed25519)
curl -X POST https://vaubaan.com/api/v1/bash-bindings/$BID/hosts \
  -H "Cookie: $SESSION" -H "Content-Type: application/json" \
  -d '{
    "orgSlug": "acme",
    "host_slug": "prod-1",
    "host_address": "10.0.0.42",
    "port": 22,
    "ssh_user": "ops",
    "generate_key": true
  }'
# Response: { "host": {...}, "public_key": "ssh-ed25519 ... vaubaan-gateway" }
# → coller `public_key` dans authorized_keys de l'hôte.

# 3. Smoke test (uptime)
curl -X POST "https://vaubaan.com/api/v1/bash-bindings/$BID/hosts/$HID/test?orgSlug=acme" \
  -H "Cookie: $SESSION"

# 4. Invoquer un tool
curl -X POST https://vaubaan.com/api/v1/bash-bindings/$BID/run-tool \
  -H "Cookie: $SESSION" -H "Content-Type: application/json" \
  -d '{
    "orgSlug": "acme",
    "host_slug": "prod-1",
    "tool": "my_logs",
    "args": { "lines": 200 }
  }'
```

## Comment debug

- **`parse_error` non-null après une PATCH `bash_content`** → l'UI affiche
  le message tel quel (`parse.ts:59-64`, `ParseError`). Cas typiques :
  - `missing '# @vaubaan-rings:' declaration` — pas de ligne rings au
    script-level.
  - `tool 'X' references ring 'Y' but it isn't in @vaubaan-rings` — typo
    de ring slug.
  - `action must be 'read' or 'write', got '<v>'` — mauvaise valeur.
- **`/test` → `Connection refused`** — host inaccessible ou ssh non-listen
  sur ce port. Vérifier `host_address`/`port`.
- **`/test` → `Authentication failed`** — clé publique pas dans
  `~/.ssh/authorized_keys` de `ssh_user`. Re-générer via `generate_key:
true` et redéployer la clé.
- **`/run-tool` → `arg 'X' is required`** — `materializeArgs` rejette :
  le script attend un `@vaubaan-arg: X … required` non fourni dans
  `args` (et sans `default=...` de secours).
- **`/run-tool` → `tool 'X' is not declared by this script`** — le
  parsed_meta cache ne contient pas X. Re-PATCH le `bash_content` (force
  re-parse) ou vérifier le bloc `# @vaubaan:` au-dessus de la fonction.
- **Output truncated** — stdout dépasse 1 MiB
  (`MAX_STDOUT_BYTES`, `execute.ts:18`). `truncated: true` dans la
  réponse. Pipe `head`/`tail` côté script.
- **Inspecter le `parsed_meta`** — `select id, slug, parsed_meta from
bash_bindings where id = '...'` (service_role uniquement — RLS bloque
  côté users).

## Extension

### Ajouter un nouveau type de tool

Pas d'extension nécessaire côté provider — il suffit d'éditer le
`bash_content` du binding et d'ajouter une fonction annotée. Le parser
détecte automatiquement les nouvelles fonctions au prochain PATCH.

### Wirer `/mcp` pour `bash__*`

L'`UpstreamAdapter` pour `bash` n'est pas encore implémenté
(`build.ts:251-254`). Pour le câbler il faudra :

1. Plumber `classifySshV4(tool, args, bindings)` (déjà existant dans
   `plugins/ssh/src/risk-classifier.ts`) : tool MCP
   `bash__<binding_slug>__<function_name>` → resolve le binding via slug,
   lookup le ring du tool, émettre un `Slice` v4
   (`ssh.host[X].command.R|W`).
2. Un `executeCallSelfContained(ctx, tool, args)` qui réutilise
   `materializeArgs` (`lib/bash/args.ts`) + `buildToolInvocation`
   (`lib/bash/exec.ts`) + `execOnHost` (`lib/bash/exec-host.ts`) — toute
   la logique est déjà factorisée pour ce wiring.
3. Le `loadProviderAdmin` est sans objet pour bash (pas de
   `provider_admins` ; l'auth se fait par-host via clé SSH stockée sur
   `ssh_bindings`). Le commentaire `gateway.ts:86-105` documente déjà
   ce pattern _self-contained_ ; cf. [`mcp-gateway.md`](./mcp-gateway.md)
   §Self-contained adapters.
4. Quand le dispatch atterrit, drop `writeRestBypassAudit` côté route REST :
   l'audit row sera produite par le gateway normal path (cf. TODO marker
   `TODO(bash-mcp-wiring)` dans `run-tool/route.ts`).

### Ajouter un nouveau type d'argument

`ParsedArg.type` est limité à `'string' | 'integer'` (`parse.ts:30-34`).
Pour ajouter `boolean` ou `enum`, étendre :

- `parse.ts` ligne 131 (mapping `parts[1] === 'integer' ? 'integer' : 'string'`).
- Le coercion côté `run-tool/route.ts:91-103` (actuellement
  `String(raw)`).
- Côté UI `runner-card.tsx` pour le widget de saisie.

## Références

- Handbook v4 (data-model + risk catalog + tool → slice) :
  [`docs/handbook/providers/railway-ssh.md`](./providers/railway-ssh.md) §2.
- Spec : [`docs/spec/gateway-risk-model.md`](../spec/gateway-risk-model.md)
  §3 (DSL), §4 (catalog), §7 (plugin).
- Migrations : `supabase/migrations/0011_add_vps_ssh.sql` (init),
  `0012_rename_vps_ssh_to_ssh.sql`, `0020_bash_provider.sql` (pivot),
  `0021_bash_bindings.sql` (split).
- ADR template providers : [`docs/decisions/provider-onboarding-handbook-template.md`](../decisions/provider-onboarding-handbook-template.md).
- Tests : `apps/gateway/src/lib/bash/{parse,exec,args,exec-host}.test.ts`
  - `plugins/ssh/tests/unit/risk-{catalog,classifier}.test.ts`.
