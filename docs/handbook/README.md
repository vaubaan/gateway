---
title: Handbook — index
tracks:
  - docs/handbook/
last_reviewed: 2026-10-31
---

# Handbook — index

How the code works today, where the code does not say it: entry points,
cross-file invariants, traps, what lives outside the repo, procedures. The
what and why are in [`docs/spec/`](../spec/), the choices in
[`docs/decisions/`](../decisions/). Deploying: [`deploy/README.md`](../../deploy/README.md).
New to the code: read [architecture](../architecture.md) first, the path of a request in ten
minutes.

## Running an instance

- [configuration](configuration.md) — configuration keys, crypto, the composition root.
- [store](store.md) — the embedded SQLite store, migrations, backups.
- [limits-and-counters](limits-and-counters.md) — ceilings on users, connections, active missions; `GET /ops/stats`.
- [oauth-broker-contract](oauth-broker-contract.md) — the calls between an instance and an OAuth broker.
- [oauth-broker](oauth-broker.md) — the OAuth broker of `apps/oauth-broker`: running it in Confidential Space, releasing and verifying its image.
- [first-install](first-install.md) — the acceptance run of a first installation, and reading a refusal.
- [import-from-v4](import-from-v4.md) — the one-shot import of a v4 organization.
- [demo-mode](demo-mode.md) — `npm run demo`: the real app with a simulated IdP and services.
- [threat-model](threat-model.md) — what the gateway defends, against whom, with which control and proof.
- [known-limitations](known-limitations.md) — what has not been done and what is not there (published on the website).
- [website](website.md) — the public site, generated from the repository.

## Humans

- [authentication](authentication.md) — sign-in providers, admission, web session, bootstrap token, administrators.
- [authority](authority.md) — owners, shares, local groups, orphaned missions.
- [connections](connections.md) — connecting an account, credential refresh, resources.
- [missions](missions.md) — issuing and editing a mission, members and tokens, the kit.
- [requests](requests.md) — claims and approvals: the URL, who decides, expiry.
- [audit](audit.md) — activity, retention, administrative entries.
- [web-app](web-app.md) — the frame of the interface: layouts, shell, words, design system.

## Agents

- [execution-door](execution-door.md) — `/mcp`: the call pipeline, agent label, streaming, catalog.
- [git-remote](git-remote.md) — `/git/<owner>/<repo>.git`: fetch relayed, push decided ref by ref.
- [management-door](management-door.md) — the authorization server and the tools of `/mcp/manage`.
- [budget-and-sessions](budget-and-sessions.md) — how an allowed call is counted against its budget.

## Engine and plugins

- [gateway-core](gateway-core.md) — the decision core: refusals, audit entry, mission context, pipeline.
- [policy-engine](policy-engine.md) — pure modules around slices and risk catalogs.
- [plugin-sdk](plugin-sdk.md) — what a provider plugin is written against; the one list of providers.
- [telemetry](telemetry.md) — community telemetry, off at installation.
- [providers/README](providers/README.md) — index of the per-provider handbooks.

The v4 handbooks are gone from the tree; the tag `v4-final` keeps them.
