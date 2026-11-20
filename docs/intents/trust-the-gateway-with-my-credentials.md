---
title: Trust the gateway with my credentials
status: proposed
actors: [administrator]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-20
---

# Trust the gateway with my credentials

As an administrator, I want a plugin to reach only its own service's credential and the gateway's
security checked by someone outside the project, so that I trust it with every account I connect.

## Run each plugin outside the gateway's process

status: proposed
requires: plugin, account
spec: ../spec/vaubaan-gateway.md#6-security
acceptance:

- A plugin runs in a process of its own and receives only the credential of the account its call uses
- A plugin that reads memory or files outside what it was handed finds no other account's credential
- The threat model no longer lists "a plugin runs beside every decrypted credential" as an accepted risk

## Read a third-party security review

status: proposed
requires: gateway
spec: ../spec/vaubaan-gateway.md#6-security
acceptance:

- A review by a named firm outside the project is published on the trust center, with its date, scope and the version reviewed
- Every finding is listed with what was done about it, and the site stops saying no third-party audit exists
