---
title: Trust the gateway with my credentials
status: proposed
actors: [team-lead, security-reviewer]
spec: [../spec/vaubaan-gateway.md, ../spec/website.md]
last_reviewed: 2026-11-22
---

# Trust the gateway with my credentials

As a team lead, or the security reviewer who answers for the team, I want to read plainly what the
gateway protects and what it does not, a plugin to reach only its own service's credential, and the
gateway checked by someone outside the project, so that I trust it with every account I connect.

## Read what the project does not protect

status: implemented
requires: trust-center
anchors: apps/website/src/content/trust.ts, apps/website/src/app/trust/page.tsx, apps/website/tests/unit/site/units.test.ts
relieves: marketing-before-facts
delivers: what-is-not-covered-written-plainly, deciding-without-installing
spec: ../spec/website.md#25-trust-center--trust

## Run each plugin outside the gateway's process

status: proposed
requires: plugin, account
relieves: third-party-code-beside-decrypted-credentials
spec: ../spec/vaubaan-gateway.md#6-security
acceptance:

- A plugin runs in a process of its own and receives only the credential of the account its call uses
- A plugin that reads memory or files outside what it was handed finds no other account's credential
- The threat model no longer lists "a plugin runs beside every decrypted credential" as an accepted risk

## Read a third-party security review

status: proposed
requires: gateway
relieves: no-outside-proof, my-security-reviewer-says-no
delivers: my-security-said-yes
spec: ../spec/vaubaan-gateway.md#6-security
acceptance:

- A review by a named firm outside the project is published on the trust center, with its date, scope and the version reviewed
- Every finding is listed with what was done about it, and the site stops saying no third-party audit exists

## Go back to the former version after an update

status: implemented
requires: instance
anchors: apps/gateway/src/server/store/pre-migration-copy.ts, apps/gateway/src/server/store/pre-migration-copy.test.ts, apps/gateway/tests/integration/store/pre-migration-copy.test.ts, apps/website/content/docs/operations/upgrade.mdx
relieves: an-update-that-breaks-on-a-monday
spec: ../spec/vaubaan-gateway.md#6-security
acceptance:

- A start that migrates the store first leaves a copy of it beside the store, and keeps the three most recent
- The former image, given that copy with `restore.mjs --force`, starts on the data as it was before the update
- A copy that cannot be written stops the start before any migration runs, and says why
