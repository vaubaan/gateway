---
title: One word per thing — account, service, plugin — in the interface, the code and the protocol
status: accepted
date: 2026-11-14
author: Renaud Pelissier
---

# One word per thing — account, service, plugin — in the interface, the code and the protocol

## Context

The interface said account where the code, the protocol and the store said connection, and the
human docs mixed account, connection, provider, service and plugin for two things. Every reader of
the code, every agent and every page paid for the mapping in `lib/vocabulary.ts`, and the word
account already meant something else in the code: the password sign-in of the instance.

## Decision

An **account** is your account at a service, plugged once into the instance; a **service** is
GitHub, Vercel, Gmail…; a **plugin** is only the code package. The interface, the code, the store
and the protocol say the same word: connection becomes account now (R1), provider becomes service
next (R2), the sign-in provider staying explicit (`signInProvider`, IdP). The instance's password
accounts are **sign-in accounts**.

## Consequences

- A new name, field, code or page uses these words; the word connection is left only to its
  unrelated senses (TLS, database, socket, SMTP/IMAP), and a guard test holds the human-facing
  text to it.
- Stored bytes never move with a word: ids, the AEAD associated data, the KDF context
  `vaubaan/connection-key/v1:`, token hashes. The callback `/connections/callback/<plugin>` keeps
  its path: it is registered at the services and at the brokers.
- Compatibility: a migration renames tables, columns and stored act and refusal names in place; a
  backup written before the rename restores; a configuration key or variable of the old word is a
  deprecated alias with one boot warning; the plugin SDK keeps the old exports `@deprecated` for
  one minor. Tool names and refusal codes seen by agents break cleanly while in alpha, each listed
  in the changelog. The telemetry payload keeps its names: it is the collector's schema.

## Rejected alternatives

### Keep the protocol's names and bridge them in the interface

What [interface-redesign-vocabulary-and-design-system](interface-redesign-vocabulary-and-design-system.md)
chose for every word. For the thing people handle most, two names cost every reader, every agent
instruction and every bug report more than one alpha break.

### "Cloud account", "service account" or "cloud service account"

Not every service is a cloud, and service account already names a robot identity at GCP and in
Kubernetes: a reader would take it for one.

## Amendment 2026-11-15: rename R2 done — provider is service

### Context

R2 renamed provider to service; the word provider also named the sign-in provider (the identity
provider people sign in through) and the OAuth provider an OAuth broker holds a client at, and
the site still mixed the four words with plugin.

### Decision

Service everywhere for GitHub, Vercel, Gmail…: types, modules, routes, API fields, the
`vaubaan` plugin's tools and answers, connect errors, the SDK (0.9.4) and the store (migration
0037). The sign-in provider is always said in full — `signInProvider` in code, `sign_in_provider`
in the store, the logs and the audit — so that no bare provider is left. The OAuth broker keeps
provider: it is its protocol's word (`provider` in `POST /flows`, `oauth_brokers.<name>.providers`),
shared with the deployed brokers and the RFC.

### Consequences

- Stored bytes do not move: a RiskId holds a service id, never the word; ids, AAD and keys are
  unchanged. The migration rewrites the audit's JSON by the sense of each act (a sign-in act's
  `provider` → `sign_in_provider`, any other → `service…`), and the web sessions.
- The SDK keeps `ProviderPlugin`, `ProviderLabel`, `providerForTool` and a catalog's `provider:`
  until 0.10; a plugin pinned from an earlier SDK is read in the new words both ways.
- No configuration key changes (none named the service); the retired `providers.<id>.*` and
  `VAUBAAN_PROVIDER_*` keep their names. The site's `/docs/providers` redirects to
  `/docs/services`. The guard test also refuses provider for a service and "the <Name> plugin"
  credited with what the service does.
