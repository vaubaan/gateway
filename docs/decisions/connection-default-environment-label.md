---
title: A connection carries a default environment label for its unlabelled resources
status: accepted
date: 2026-10-18
extends:
  - connect-driver-and-resource-curation
---

# A connection carries a default environment label for its unlabelled resources

## Context

An environment label is set per resource, by the connection's owner or by the
plugin at discovery (Stripe `test` / `live`). A resource without a label refuses
every environment-qualified risk (spec §0 "Resource": "an unlabelled resource is
never treated as a safe default"); issuance warns with `resource-without-env`.

For a connection whose resources are created continuously — a Fly organization,
a Railway workspace — every new resource is unlabelled until its owner labels it
by hand, so no mission can act on it in the meantime. Most of these accounts are
entirely one environment (a staging organization). The owner already knows the
answer; the gateway asks it again for each resource.

## Decision

1. A connection has an optional **default environment** (`connections.default_env`,
   migration `0017`), chosen by its owner among the environment labels the
   provider's catalog knows (the `env` of its env-qualified risks). `NULL`, the
   default, keeps the earlier behaviour.
2. The **effective** environment of a resource is its own label when it has one,
   else the connection's default. A resource's own label — set by the owner or by
   the plugin — always wins; a plugin-set label is never overridden.
3. It is materialized **in one place**: the connections repository's resource read
   (`listResources`, `getResource`, `syncDiscoveredResources`'s answer) returns
   `env` = the effective label and `envSource = 'connection-default'` when the
   label came from the connection. Every reader of resource environments —
   mission issuance and its notices, the execution door's resolver
   (`envResolverFor`, fed by the mission context), the management door
   (`list_my_connections`), the account pages and the share notes — reads that
   record, so they cannot diverge. The stored `connection_resources.env` stays the
   resource's own label (`'connection-default'` is never written there), so
   clearing the default gives every such resource back its own state.
4. It is an explicit, owner-only, audited act: `ConnectionService.setDefaultEnv`
   (`POST /accounts/<id>/default-env`, the same guard as the other owner
   mutations), refused with `invalid-input` for a label the catalog does not know
   and with `connection-revoked` on a revoked connection; one
   `connection-default-env-set` audit entry with the label `before` and `after`.
   The account page shows it ("Default environment for unlabelled resources")
   and names the resources that carry it as "from the account's default".
5. The management door says it: `env_qualified_risks.default_env` in
   `list_my_connections`.

The spec sentence is amended, not contradicted: an unlabelled resource is still
never treated as a safe default; a default the owner explicitly chose for the
connection is a label, and applies as one.

## Consequences

- A new resource of a single-environment account is usable by missions as soon as
  discovery sees it, with no hand labelling.
- A mission that selected a resource reaches the env-qualified risks of the
  default's environment from the moment the owner sets it, and loses them when
  the owner clears or changes it, like a change of the resource's own label.
  The act is audited for that reason.
- An owner who wants one resource out of the default labels it explicitly; the
  form shows the resource's own label (empty when it inherits).
- Providers whose plugin derives the environment from the call (`envOf`, Vercel)
  are unchanged: the derived environment still comes first.

## Rejected alternatives

- **A silent default** (treat an unlabelled resource as the least dangerous
  environment, e.g. `staging`). It contradicts the spec's fail-closed rule: a
  production resource nobody labelled would be acted on as staging.
- **A per-provider default** (one default for every connection of Fly). Two
  connections of the same provider are routinely different environments (a
  staging organization and a production one); the label belongs to the account,
  and its owner, not to the instance's operator.
- **Plugin-derived environment only** (`envOf`, or a plugin reading the
  environment from the provider). Fly and Railway expose no reliable environment
  attribute on an app or a project; guessing from names is the silent default
  again, in the plugin.
- **Writing the default into each unlabelled resource row** (a backfill at set
  time and at discovery). Clearing the default could no longer tell the owner's
  labels from the default's copies, and every writer of resources would have to
  remember to apply it.
