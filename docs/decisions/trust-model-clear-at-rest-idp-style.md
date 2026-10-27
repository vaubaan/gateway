---
title: Trust model — IdP-style, credentials encrypted at rest and opened in memory per call
status: accepted
date: 2026-05-22
---

# Trust model — IdP-style, credentials encrypted at rest and opened in memory per call

## Context

To filter a call on its tool and arguments and forward it, the gateway must itself open the
provider credential, mint any short-lived upstream token and send the request. That rules out zero
knowledge: whoever runs the gateway can, in principle, use the credentials it holds.

## Decision

The gateway follows the IdP trust proposition (Okta, Cloudflare Access): provider credentials are
encrypted at rest under the instance's master key, opened in memory only for an authorised call,
and never written in clear; the operator of the process is trusted, and on-prem that operator is
the company itself.

## Consequences

- Semantic filtering on arguments, the product's value, is possible.
- A compromised running instance compromises every credential it holds; encryption at rest protects
  a stolen volume or backup, the audit gives detection, key rotation bounds the window.
- In-memory caches of credentials are bounded and dropped on revocation
  ([upstream-credential-cache-and-rejected-credentials](upstream-credential-cache-and-rejected-credentials.md));
  no credential reaches a log.
- A buyer needing an HSM or zero knowledge needs a dedicated design.

## Rejected alternatives

### Partial zero knowledge (filter on the tool name, decrypt on the client)

Brings back a client-side runner and loses the filtering that matters, on arguments.

### A cloud HSM

Costly and unjustified for the target users; reconsiderable for regulated deployments.

### A separate decryption service (an external Vault)

One more service to operate that holds the keys itself, so the model does not change.
