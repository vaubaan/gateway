---
title: Choose how my instance signs in to a service
status: proposed
actors: [administrator]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-20
---

# Choose how my instance signs in to a service

As an administrator, I want to choose in Settings which broker or which client of my own serves
each service with no key to paste, so that connecting Google Calendar or Outlook never needs a
configuration file or a restart.

## Add an external broker in Settings

status: proposed
requires: administrator
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- Settings › Administration › OAuth brokers adds a broker by URL, enrolment key and attestation, its key never shown back
- A broker added here stays off until its test, a sign-in in another window that connects nobody, has passed
- A broker set by the configuration file shows read-only and always on
- Every add, edit, test and removal is in the audit

## Use this gateway's own client at a service

status: proposed
requires: administrator, service
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- The page shows the redirect to register at the service, ready to copy, and takes the client id and secret, the secret never shown back
- After a change of public URL, the page marks the client as to re-register and says where

## Choose the source that serves each service

status: proposed
requires: administrator, service, account
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- The page lists each service shipped plugins sign in to through a broker, with the one source serving it and whether it is attested
- Changing the source is confirmed with its consequence, and accounts connected through the former one keep working
- A service no source serves says "not configured" on Connect an account, with the way to Settings for an administrator
