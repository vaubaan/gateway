---
title: Revoking a connection withdraws the grant at the provider when the provider documents how; the outcome is stored and shown
status: accepted
date: 2026-10-13
---

# Revoking a connection withdraws the grant at the provider when the provider documents how

## Context

Revoking a connection erased the instance's credential and did nothing at the provider. An OAuth
authorization nobody removed is a standing grant, and a refresh token leaked earlier still works.
But a pasted token or API key was made by a person who may use it elsewhere.

## Decision

A connection is revoked locally first, then the provider is asked to withdraw the grant within ten
seconds, only through an endpoint read in the provider's documentation: declaratively for `oauth2`
(sent by the host, which holds the client secret), by its broker for a brokered connection, or by
a plugin `revoke` hook. The outcome (`revoked`, `manual`, `failed`) is stored on the connection and
shown; pasted keys and SSH grants are left alone.

## Consequences

- Whatever the provider does, the connection stays revoked and refuses every call.
- Every plugin declares `manualRevocation`, where a person removes a grant still standing.
- A new endpoint enters through its plugin, the handbook table and the structural test, with its
  source; a guessed URL would receive a refresh token.

## Rejected alternatives

### Ask the provider first, revoke locally on success

An outage would keep alive a connection its owner wanted dead.

### Hand the client secret to a plugin `revoke`

Breaks the rule that a plugin never receives a client secret.

### Delete API keys through the providers' token APIs

The key is not the gateway's to delete.

### Keep the outcome in the audit only

A grant still standing must be in front of the owner, not in a log.
