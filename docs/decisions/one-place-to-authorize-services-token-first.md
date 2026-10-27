---
title: One place to authorize a service; the service's page guides to the simplest way, a pasted token whenever the service offers one
status: accepted
date: 2026-10-20
author: Renaud Pelissier (product owner), drafted with Claude
---

# One place to authorize a service, a pasted token whenever the service offers one

## Context

The gateway sends a key to a service on every call, however the account was connected. A company
app (GitHub App, OAuth clients) costs a registration form, a private key or client secret to copy,
settings to remember and a page to explain them; even the one-click GitHub manifest created an App
private to its owner, so a second organisation could not be connected. It is always a key; the
only difference is who makes it.

## Decision

Each plugin declares one way to connect, the simplest its service offers: a key a person can make
whenever one works, otherwise the service's sign-in with nothing for an administrator to declare (a
client the gateway registers itself, or the OAuth broker). There is no company app layer: no
GitHub App, no installation tokens, no administrator-declared OAuth client.

## Consequences

- One path per plugin: one credential, one execute, one discovery, one guide.
- The store holds long-lived keys; master-key encryption at rest is their protection.
- Actions are attributed at the service to the person who pasted the token; a neutral author is a
  dedicated account.
- A key with a lifetime (a fine-grained token: one year) is reconnected by hand when it expires.

## Rejected alternatives

### Keep the GitHub App, token first elsewhere

Short-lived scoped keys are real, but every administrator pays the registration at install, for a
protection the product does not claim for the other providers.

### Apps only, no pasted token (the v4 position)

Several apps to register before the first connection of a self-hosted instance.

### A shared app operated by Vaubaan

Its private key would mint tokens for every customer's installation from every instance; reserved
to a hosted offer whose keys never leave Vaubaan.

### Keep both ways and hide the app way

Two paths per plugin in code, tests and docs for a way no instance is expected to use.
