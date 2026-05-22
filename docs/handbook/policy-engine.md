---
title: Policy engine
status: current
date: 2026-05-22
tracks:
  - packages/policy-engine/src/
  - packages/policy-engine/tests/unit/
---

# Policy engine — `@vauban/policy-engine`

Le cœur d'évaluation du MCP Proxy. Prend une `(roles, bindings, call)` et
retourne une décision `allowed | denied` avec une raison actionable.

## Layout

```
packages/policy-engine/
  src/
    dsl.ts            # Zod schemas pour Permissions, Rule, Constraint
    operators.ts      # 7 opérateurs + dot-path reader
    target.ts         # résolution project.repos / project.vercel / project.supabase
    evaluate.ts       # decision flow + denial reason builder + suggestion hint
    tools-filter.ts   # static filter pour tools/list
    index.ts          # barrel
  tests/unit/
    operators.test.ts   (20 tests)
    evaluate.test.ts    (12 tests)
    dsl.test.ts          (7 tests)
    tools-filter.test.ts (3 tests)
```

## DSL en deux phrases

Un Role = `{ version: 1, rules: Rule[] }` stocké en `jsonb`. Une Rule =
`{ effect: 'allow'|'deny', tool?|tool_matches?, target?, constraints? }`.
Tout est déclaratif (cf. ADR [[policy-dsl-declarative-jsonb]]).

## Évaluation — pseudo-code

```ts
function evaluatePolicy(roles, bindings, call) {
  const matchingRoles = roles.filter(r => r.provider === call.provider);
  if (matchingRoles.length === 0)
    return denied(`no role covers provider '${call.provider}'`);

  for (role of matchingRoles)
    for (rule of role.permissions.rules) {
      if (!toolMatches(rule, call.tool)) continue;
      if (!targetMatches(rule, call, bindings)) record(role, rule, 'target failed');
      else if (!constraintsMatch(rule, call.arguments)) {
        if (rule.effect === 'allow') record(role, rule, 'constraint failed');
        else /* deny */ updateBestDeny(...);
      } else {
        if (rule.effect === 'allow') updateBestAllow(...);
        if (rule.effect === 'deny') updateBestDeny(...);
      }
    }

  if (bestDeny) return denied(bestDeny.reason + suggestion);
  if (bestAllow) return allowed(bestAllow.role.name);
  // default deny — first failed allow gets a tailored reason
  return denied(firstFailure.reason + suggestion);
}
```

**Règles cardinales :**

- _Default deny_ : aucune allow ne matche → denied.
- _Deny override allow_ : entre deux rules matchant le call, deny gagne.
- _Priority sur deny_ : `rule.priority` (default 100), valeur supérieure gagne.
- _Premier allow gagne_ entre deux allow matchant (ordre du `rules[]`).

## Operators (cf. `operators.ts`)

| Op                | Vrai si …                                   | `undefined` matche |
| ----------------- | ------------------------------------------- | :----------------: |
| `equals: x`       | `String(value) === String(x)`               |       false        |
| `in: [...]`       | `[...].map(String).includes(String(value))` |       false        |
| `not_in: [...]`   | l'inverse                                   |      **true**      |
| `match: [...]`    | OR sur `minimatch(value, pattern)`          |       false        |
| `regex: '...'`    | `new RegExp(pattern).test(String(value))`   |       false        |
| `starts_with: x`  | `value.startsWith(x)` ; array → OR          |       false        |
| `not_starts_with` | l'inverse                                   |      **true**      |

Le path `arguments.branch` traverse l'objet `{ arguments: <args> }`.

## Target abstrait

| Target             | Résout vers                                           |
| ------------------ | ----------------------------------------------------- |
| `project.repos`    | `[binding.resource_ref]` du provider_binding `github` |
| `project.vercel`   | idem pour `vercel`                                    |
| `project.supabase` | idem pour `supabase`                                  |
| `*`                | matche tout                                           |

Pour GitHub, le check construit `<arguments.owner>/<arguments.repo>` et vérifie
qu'il est dans la liste résolue. Pour Vercel / Supabase : `arguments.project_id`
ou `arguments.project_ref`.

## tools/list static filter

Le gateway répond à `tools/list` en énumérant uniquement les tools qu'au moins
une allow rule peut potentiellement appeler. Les constraints ne sont pas
évaluées (elles dépendent des args runtime). Ça réduit la confusion de
l'agent (cf. spec §7.2).

## Denial reasons actionable

Le builder de denial reason inspecte la rule failed et compose un message
de la forme :

> `argument 'branch' = 'main' is not allowed by role 'github:developer'
(expected to match ["feature/*","fix/*","claude/*"]).
Suggestion: rename the branch to match one of feature/*, fix/*, claude/*
(e.g. 'feature/<name>').`

L'agent (Claude Code, Cursor) peut lire ce message et corriger son call.
C'est le différentiateur produit : le proxy est _trainer_, pas mur.

## Tests

`npx vitest run packages/policy-engine` — 42 tests, ~340ms.
