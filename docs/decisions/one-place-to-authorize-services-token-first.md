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

## Amendment 2026-10-31: the breadth of the grant

### Context

Every guide asked for the narrowest token ("only the repositories the missions need", "tick these
and nothing else"). The person then came back to the service each time a mission needed one more
repository or permission, while the gateway already narrows every call: a mission reaches only its
resources and its accepted risks. Five token plugins shipped with no guide at all.

### Decision

The person grants once the widest the service offers for what the account connects (every
repository, every zone, every permission the plugin's tools use, a secret key rather than a
restricted one); each mission is the narrowing. The guide says so and gives this reason. A key
pasted once is the way whenever it does the job: no integration, OAuth app or service account to
create for it. A plugin with a token way is accepted only with a complete guide: the token page
itself, imperative steps, how wide to grant and why, the permissions mapped to the tools they
unlock, who knows the expiry, the service's documentation, and a check at paste naming the account.

### Consequences

- `definePlugin` refuses an `api-key` way without `label`, `createUrl`, `guide` (`steps`, `reach`,
  `permissions`, `expiry`, `docsUrl`) or `verify`: the instructions are part of the contract.
- A leaked token reaches more at the service; its protection stays the master-key encryption at
  rest, the service's own revocation and an expiry the person chose or the service reports.
- Where the service lists no permission choice, the guide says what the token opens instead.

### Rejected alternatives

#### Least privilege at the service, as each service advises

Each new need of a mission is a new token and a reconnect; the narrowing already happens, call by
call, in the gateway.

#### Optional guides, checked by review

Five plugins shipped without one; only a rule at definition keeps a new plugin from doing the same.
