---
title: Drop the 3-gate model — replace by accepted_risks + runtime escalation
status: accepted
date: 2026-06-16
supersedes:
  - pivot-to-risk-based-model
extends:
  - unified-tokens-delegation-chain-and-escalation-channel
---

# Drop the 3-gate model — unified accepted/not-accepted + runtime escalation

> **ACCEPTED 2026-06-16** par Renaud. Évolution conceptuelle qui réduit
> le modèle d'autorisation à deux états binaires : un risk est **dans
> `accepted_risks` (= autorisé)** ou **pas (= refusé)**. Le 3e état
> intermédiaire `confirm` (gate au mint qui ouvrait un approval flow
> Telegram/Email) est supprimé : il était fonctionnellement identique
> à une demande d'élévation runtime via l'`escalation_channel`
> introduit par l'ADR [[unified-tokens-delegation-chain-and-escalation-channel]].

## Contexte

L'ADR [[pivot-to-risk-based-model]] établit en v4 un modèle 3-gate :

| Gate      | Sémantique mint-time                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow`   | L'opérateur peut accepter le risk sans cérémonie.                                                                                                                 |
| `confirm` | L'opérateur peut accepter, mais un humain doit valider via Telegram / Email / Manual avant que le token ne soit émis (`POST mint` répond 202, polling, puis 201). |
| `deny`    | L'opérateur ne peut pas accepter — risk barré dans la UI.                                                                                                         |

L'ADR [[unified-tokens-delegation-chain-and-escalation-channel]] ajoute
en parallèle un mécanisme d'**élévation runtime** : un child token qui
prend un 403 `risk-not-accepted` poste à son
`context.escalation_channel` pour demander à son parent un nouveau
token au scope élargi.

Trois faiblesses cumulées :

**1. `confirm` et l'élévation runtime sont la même chose à un timing
près.** Le `confirm` flow demande à un humain de valider une
acceptation au mint ; l'élévation runtime demande à un humain (ou
agent parent) de valider une acceptation après un 403. Mêmes acteurs,
même primitive (notification → décision humaine → mint élargi). Les
maintenir séparés double l'infrastructure (`approval_requests` table

- `project_approval_channels` table + Telegram webhook + email
  signed-link + long-poll endpoint, vs. POST HTTP libre côté agent).

**2. `deny` n'apporte rien de plus qu'un risk non-coché.** Aujourd'hui :

- `default_gate=deny` au catalog → checkbox grisée côté UI mint.
- `default_gate=allow` au catalog mais opérateur ne coche pas → risk
  non-accepted → runtime denied.

Dans les deux cas, le résultat fonctionnel est identique : le risk
n'est pas dans `token.accepted_risks`, et le runtime renvoie 403 si
touché. Le `deny` actif au catalog n'est qu'une heuristique UI ("ne
montre même pas l'option") qui peut être recouverte par
`acceptable_in_envs` (déjà existant, structurel et plus expressif).

**3. La table `project_risk_policies` n'a jamais été utilisée en
production.** Elle permettait à un projet d'override le `default_gate`
du catalog (passer un `allow` à `confirm`, ou un `confirm` à `deny`).
La UI pour la peupler n'a jamais été écrite — il fallait éditer
directement la DB. C'est de la complexité morte.

## Décision

### D1 — Un risk a deux états : accepté ou non

Le 3-gate `allow | confirm | deny` est **supprimé**. Un risk déclaré
dans le catalog d'un provider est :

- **acceptable** si le binding env est dans `acceptable_in_envs` (ou
  si `acceptable_in_envs` est absent).
- **accepté** ssi son `RiskId` est dans `token.accepted_risks`.

Au runtime, la décision reste identique :
`risks_touched ⊆ token.accepted_risks` → allow, sinon deny.

### D2 — Drop `default_gate` du catalog

Le champ `default_gate: 'allow' | 'confirm' | 'deny'` disparaît de
`RiskEntry`. Le catalog YAML d'un provider devient :

```yaml
- id: github.merge-protected
  label: 'Write on main / master / release-* (direct commit OR PR merge)'
  reason: '…'
  matches:
    - 'github.repo[**].branch[main,master,prod,production,release-*].W'
  vector:
    reversibility: costly
    blast: env
    data: data
    cost: moderate
    visibility: team
    persistence: session
  # acceptable_in_envs: optional — structural restriction (e.g. never on prod)
```

Le seul garde-fou structurel restant est `acceptable_in_envs` —
intentionnellement gardé : il bloque les acceptations
**impossibles-par-design** (un risk `bulk-row-write` interdit en prod
ne peut PAS être coché pour un binding `env=prod`, même par un
opérateur qui le voudrait).

### D3 — Drop `project_risk_policies`

La table est droppée. Aucun équivalent — la sévérité d'un risk est
intrinsèquement provider-level (vit dans le catalog YAML), pas
project-level. Si un projet veut serrer son scope, l'opérateur ne
coche tout simplement pas les risks concernés. S'il veut tracer une
décision "ce projet n'accepte jamais ce risk", il peut le formaliser
dans la `description` du projet ou dans un wiki — pas dans la DB du
gateway.

### D4 — Drop `approval_requests` + canaux d'approval mint-time

Tables droppées :

- `approval_requests`
- `project_approval_channels`
- (la table `mgmt_approval_channels` si elle existe)

Endpoints droppés :

- `GET /api/v1/tokens/pending/[id]` (long-poll mint pending)
- `POST /api/v1/mgmt/approvals/[id]` (operator decide)
- `POST /api/v1/projects/[id]/approvals` + `[approvalId]` (legacy mint approvals)
- `GET /api/v1/projects/[id]/approvals/[approvalId]`
- `POST /api/integrations/telegram/webhook` (Telegram callback)
- `POST /api/integrations/email/decide` (email signed-link)

UI droppée :

- `/orgs/[slug]/projects/[project]/approvals/page.tsx` (pending list)
- Tout setup UI de canaux d'approval (project settings).

Bibliothèque droppée :

- `packages/web/src/lib/approvals/` (channel.ts, manual.ts, telegram.ts,
  email.ts, email-token.ts, mint.ts pending parts, external-mint.ts,
  load-parent.ts, decide.ts, index.ts). Seul subset à porter ailleurs :
  helpers de mint sans approval flow (déplacés vers `lib/mint/`).

### D5 — Le mint endpoint ne renvoie plus 202

`POST /api/v1/tokens/mint` retourne désormais soit 201 (success), soit
4xx :

| Code | Cas                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| 201  | `accepted_risks ⊆ parent.accepted_risks` ET (pour chaque risk) `binding.env ∈ risk.acceptable_in_envs`          |
| 400  | Schema invalide / bindings incohérents / max-depth atteint                                                      |
| 403  | `accepted_risks ⊄ parent.accepted_risks` (subset violation) ou risk demandé non `acceptable_in_envs` du binding |
| 401  | Bearer manquant / invalide                                                                                      |

Plus de `202 { needs_approval, approval_id, status: 'pending', poll_url, channel }`.

Si l'opérateur veut un risk que son token parent n'a pas, il doit lui-même
escalader via l'`escalation_channel` du parent (sortie de gateway, cf.
ADR D4 [[unified-tokens-delegation-chain-and-escalation-channel]]).

### D6 — Le mint UI devient une simple checklist

`tokens/new/mint-form.tsx` est simplifié :

1. Pour chaque binding (provider × resource_ref × env), fetch le
   catalog du provider via `GET /api/v1/catalog?provider=<p>`.
2. Pour chaque entry du catalog, calculer côté serveur :
   - `acceptable: boolean` — `acceptable_in_envs` n'est pas défini OU
     `binding.env` y est inclus.
   - `inherited: boolean` — `entry.id` est dans
     `parent_token.accepted_risks` (le caller peut transmettre ce
     risk à un enfant).
3. La UI affiche :
   - Risks **acceptable AND inherited** → checkbox active.
   - Risks **non-acceptable** (env restriction) → checkbox grisée +
     tooltip "Not acceptable for env=<binding.env>".
   - Risks **non-inherited** (parent ne l'a pas) → checkbox grisée +
     tooltip "Your token doesn't carry this risk — request escalation".
4. Pas de bucket allow/confirm/deny. Pas de footer "Some risks need
   approval, mint will be pending". Pas de spinner "Waiting for
   approval".
5. Submit → 201 avec api_key OU 403 avec liste des risks problématiques
   et hint actionnable.

### D7 — Audit log inchangé

`audit_log.token_accepted_risks_snapshot`, `risks_touched`,
`slices_executed`, `delegation_chain` restent. Le seul snapshot
"gate" qu'on aurait pu retenir est supprimé (il n'existe plus).

## Conséquences

### Wire changes (casse-tout)

- `POST /api/v1/tokens/mint` réponses 202 → **drop**.
- `POST /api/v1/tokens/preview` réponse — drop le champ
  `effective_gate` du shape ; remplacé par `{ acceptable, inherited }`
  per risk.
- `RiskEntry.default_gate` → **drop**.
- Type `RiskGate`, constante `RISK_GATES` → **drop**.
- Table `project_risk_policies` → **drop**.
- Table `approval_requests` → **drop**.
- Table `project_approval_channels` → **drop**.
- Toutes les routes `/api/v1/mgmt/approvals`, `/api/v1/projects/[id]/approvals`,
  `/api/v1/tokens/pending`, `/api/integrations/{telegram,email}/decide` → **drop**.
- UI `/orgs/[slug]/projects/[project]/approvals/page.tsx` → **drop**.

### Conservés

- `acceptable_in_envs` (structurel, garde-fou non-overridable côté UI).
- `tokens.accepted_risks` (liste de RiskId, intersection avec
  `risks_touched` au runtime).
- `tokens.denied_risks` — gardé pour traçabilité explicite ("le
  manager A _refusé activement_ ce risk", utile dans
  un audit forensique pour distinguer "non coché par oubli" vs.
  "non coché par décision"). Sa sémantique runtime est identique au
  non-coché (le runtime ne consulte que `accepted_risks`).
- `escalation_channel` (D4 de l'ADR unified-tokens) — pratiques
  unifiées : un risk non accepté → 403 runtime → POST escalation_channel.
  Plus de notion de "ah ce risk avait gate=confirm donc je notifie
  un canal mint-time".

### Pour les humains roots

Avant cet ADR, un humain qui voulait pré-approver les risks confirm
avait deux choix : (a) configurer un canal Telegram/Email et répondre
au moment du mint, (b) tout cocher d'avance dans la UI.

Après cet ADR, un humain doit cocher d'avance dans la UI les risks
qu'il veut accepter. Si un agent enfant rencontre un 403 plus tard,
il poste à l'`escalation_channel` configuré sur son token (ou la
chaîne par défaut côté `vaubaan.com/escalations/<user_id>` quand
disponible). C'est la même décision humaine, mais déclenchée au
moment où elle est utile (le call qui veut le risk) plutôt qu'à
l'avance (au mint).

### Migration des installations existantes

- Les rows `approval_requests` existants : **dropped**. Aucune
  migration de données (les approvals pending devenaient stale et
  étaient purgées par cron de toute façon).
- Les rows `project_risk_policies` existants : **dropped**. Aucun
  override en prod selon `git log` sur cette table.
- Les rows `project_approval_channels` existants : **dropped**.
- Les tokens existants : **inchangés**. Leur `accepted_risks` est déjà
  la source de vérité.
- Les catalogs YAML : `default_gate:` line removed from each entry
  (5 fichiers, ~70 entries — trivial mechanical edit).

## Alternatives rejetées

### A1 — Garder `default_gate` comme hint UI

Le catalog porterait un hint "risque sévère" (recommande coché=false
par défaut) sans force fonctionnelle. Rejet : ça duplique
`vector.reversibility/blast/data` qui sont déjà les indicateurs de
sévérité. Au mieux, on peut dériver un tri visuel ordré (par
sévérité décroissante) depuis le vecteur 6D dans la UI mint, mais
pas besoin d'un champ supplémentaire.

### A2 — Garder `confirm` pour les risks "approval-mandatory"

L'argument : certains risks veulent une trace humaine explicite
("celui-là, on ne le coche pas en passant ; un humain a sciemment
validé"). Rejet : on a déjà la signature `created_by` sur le token
(qui a mint), et le `delegation_chain` snapshot dans l'audit_log.
La trace humaine d'acceptation existe — c'est l'événement mint
lui-même.

### A3 — Supprimer aussi `denied_risks`

Si `accepted_risks` est exhaustif, à quoi sert l'opt-out ? Rejet :
gardé pour la lisibilité forensique. Un manager qui voit son
agent demander un risk peut écrire "je ne veux jamais ce risk
dans cette session" et donner du signal au système (et à son audit
log) plus fort qu'un simple "non coché". Sémantique runtime
identique (le runtime ne consulte que `accepted_risks`), mais
le champ permet aux auditeurs et à la UI de distinguer.

### A4 — Garder `project_risk_policies` pour le futur

Au cas où on veut un jour des politiques par projet. Rejet :
YAGNI. Si le besoin réapparaît, on peut le rajouter — il est trivial
à introduire (column nullable sur tokens ou nouvelle table).

### A5 — Garder Telegram/Email canaux mais re-targeted

Au lieu de les utiliser pour `confirm`, les ré-utiliser pour
l'`escalation_channel` runtime. Rejet : ce n'est pas le rôle du
gateway. L'`escalation_channel` est un endpoint HTTP libre,
configuré par le parent qui mint, hors-gateway (cf. ADR
unified-tokens D4). Vaubaan peut offrir séparément
`vaubaan.com/escalations/<user_id>` comme service de bridge
HTTP→Telegram/Email, mais c'est une feature out-of-scope du gateway.

## Plan de migration (séparé)

1. SQL migration 0036 — drop tables `project_risk_policies`,
   `approval_requests`, `project_approval_channels` (CASCADE OK,
   aucun FK externe attendu).
2. Refacto `packages/shared/src/risk.ts` — drop RiskGate, RISK_GATES,
   default_gate from RiskEntry, RiskPolicyOverride.
3. Refacto des 5 catalog YAML — `yq d` sur `default_gate` champ.
4. Refacto `packages/policy-engine/` — drop `seedDefaultGate`,
   `resolveEffectiveGate`, related logic in `risk-policy.ts`,
   `risk-evaluator.ts`.
5. Refacto `lib/mint/` — drop le pending flow, drop le pickChannel,
   simplifier `computeMintPreview` à `{ acceptable, inherited }` per
   risk.
6. Refacto mint endpoint — 201 ou 4xx, plus de 202.
7. Refacto mint UI — single checklist.
8. Drop endpoints + UI approval.
9. Drop libs approvals (telegram, email, channel).
10. Rewrite spec `gateway-risk-model.md` + handbook `approvals.md`
    (renommé `escalation.md`) + handbook `web-app.md`.
11. Tests : update fixtures, drop approval test suites, add tests
    for the simplified mint preview/endpoint shape.
12. Migration applied, deployed, smoke E2E.

## Notes

- Cet ADR + l'ADR unified-tokens forment ensemble le modèle
  d'autorisation v5 (implicite, on n'aura pas de §version sticker —
  c'est une consolidation, pas un re-pivot).
- Cohérence industrie : OAuth 2.0 ne porte qu'un seul état "scope is
  accepted" ; l'élévation passe par RFC 9470 step-up auth (post-call
  challenge). On s'aligne.
- Le `denied_risks` survivant ressemble à un "negative scope" — pas
  standard en OAuth, mais utile en agentic auth pour distinguer
  opt-out actif de non-inclusion par défaut. À surveiller : si en
  pratique personne ne l'utilise, on pourra le dropper dans un futur
  ADR.
