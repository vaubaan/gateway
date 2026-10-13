---
title: Risk entries — one entry per act, a vector per environment
status: current
date: 2026-10-13
---

# Risk entries — one entry per act, a vector per environment

> **Status:** current, implemented. Complements
> [gateway-risk-model](./gateway-risk-model.md) §4.1 (the catalog entry)
> and §4.4 (qualification by environment). English rewrite of the draft
> of June 2026; what that draft planned as a migration is done.

## 0. Problem

One act can have a different risk profile depending on where it happens.
Deploying to a preview environment is reversible and seen by the team;
deploying to production is costly to roll back and seen by customers.

A catalog entry carries one six-axis vector. Describing both profiles
used to mean two entries for one act, told apart by a suffix:
`deploy-staging` and `deploy-prod`. That had three defects:

1. The qualified identifier said the environment twice:
   `railway[prod].deploy-prod`.
2. Both entries matched the same slices, so a call touched both. The
   call then needed an identifier that could not exist
   (`railway[prod].deploy-staging`).
3. Accepting "this act, wherever it is acceptable" required knowing which
   suffix went with which environment.

## 1. Rule

**One act is one catalog entry.** The entry lists the environments in
which it is acceptable, and may state how its vector differs in some of
them.

- `vector` is the default profile: the one that applies in every
  environment with no override, and when no environment is known.
- `vector_overrides` maps an environment label to **the axes that
  differ** there. Axes not named keep their default value.
- The `RiskId` carries no environment suffix. The environment appears
  once, as the qualifier: `railway[prod].deploy`.

```yaml
- id: railway.deploy
  matches: 'railway.project[**].environment[**].service[**].deployment.W'
  acceptable_in_envs: [staging, preview, dev, prod]
  vector:
    reversibility: reversible
    blast: env
    data: data
    cost: moderate
    visibility: internal
    persistence: session
  vector_overrides:
    prod:
      reversibility: costly
      visibility: public
```

### 1.1 Resolution

The vector of an entry in an environment is the default vector with that
environment's overrides applied on top. With no environment, or no
override for it, it is the default vector.

### 1.2 What the resolved vector is used for

Only for what a human reads: the severity that orders the risks of a
catalog and names the most severe risk of a preset is computed from the
vector resolved for the environment of each qualified identifier. So
`railway[prod].deploy` ranks above `railway[staging].deploy`.

It changes **no decision**. Whether a call is allowed depends on the
risks it touches and the risks the mission accepts
([gateway-risk-model](./gateway-risk-model.md) §8), never on a vector.

### 1.3 Validity

A catalog is refused at load when an override names an invalid
environment label, an axis that does not exist, or a value outside the
scale of its axis.

An override is expected only for an environment the entry lists in
`acceptable_in_envs`; an override for another environment would never be
read.

## 2. Entries that use it

In the catalogs shipped with the gateway:

| Entry                      | Acceptable in               | Overrides                                                           |
| -------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `railway.deploy`           | staging, preview, dev, prod | prod: reversibility `costly`, visibility `public`                   |
| `railway.upsert-variable`  | staging, preview, dev, prod | prod: reversibility `costly`                                        |
| `vercel.deploy`            | preview, development, prod  | prod: reversibility `costly`, blast `env`, visibility `public`      |
| `vercel.env-var-write`     | preview, development, prod  | prod: reversibility `costly`                                        |
| `ssh.exec-write`           | dev, staging, prod          | prod: reversibility `irreversible`, data `secret`, cost `unbounded` |
| `ssh.exec-destructive`     | dev, staging, prod          | prod: data `secret`, cost `unbounded`                               |
| `ssh.exec-service-control` | dev, staging, prod          | prod: visibility `public`                                           |

The two Vercel entries each list two patterns, one for the non-production
environments and one for production, because the environment is a
segment of the slice for that provider.

## 3. What this rule does not cover

- **An act that is not acceptable somewhere.** That is expressed by
  leaving the environment out of `acceptable_in_envs`
  (`supabase.bulk-row-write` is not acceptable in production), not by a
  vector.
- **Scope caps per environment.** Not designed; scope caps themselves are
  not enforced in v5.0
  ([gateway-risk-model](./gateway-risk-model.md) §4bis).
- **Account-scoped entries.** An entry with no `acceptable_in_envs` is
  never qualified and has one vector.
