---
title: Risk entries — one entry per act, a vector per environment
status: stable
---

# Risk entries — one entry per act, a vector per environment

> **Status:** stable. Complements [gateway-risk-model](./gateway-risk-model.md) §4.1 (the entry) and
> §4.4 (qualification by environment).

## 0. Problem

One act can have another risk profile per environment (a preview deploy is reversible, a production
one is not). Two entries for one act (`deploy-staging`, `deploy-prod`) would say the environment
twice in the qualified id and match the same slices.

## 1. Rule

**One act is one catalog entry.** It lists where it is acceptable (`acceptable_in_envs`) and may
state how its vector differs in some of them.

- `vector` is the default profile: every environment without an override, and no environment.
- `vector_overrides` maps an environment label to **only the axes that differ** there.
- The `RiskId` carries no environment suffix; the environment appears once, as the qualifier:
  `<provider>[prod].deploy`.

### 1.1 Resolution

The vector in an environment is the default with that environment's overrides applied on top; no
environment or no override: the default.

### 1.2 What the resolved vector is used for

Only what a human reads: the severity that orders a catalog's risks and names a preset's most severe
risk is computed per qualified id, so `[prod].deploy` ranks above `[staging].deploy`. It changes
**no decision** ([gateway-risk-model](./gateway-risk-model.md) §8).

### 1.3 Validity

A catalog is refused at load when an override names an invalid environment label, an unknown axis,
or a value outside its axis's scale. An override for an environment outside `acceptable_in_envs` is
never read.

## 2. Entries that use it

Each provider's handbook lists its entries with overrides (typically deploy, environment-variable
writes, remote shell, raised in `prod`).

## 3. What this rule does not cover

- **An act not acceptable somewhere**: leave the environment out of `acceptable_in_envs`, not a
  vector.
- **Scope caps per environment**: not designed ([gateway-risk-model](./gateway-risk-model.md)
  §4bis).
- **Account-scoped entries**: never qualified, one vector.
