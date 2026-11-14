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
