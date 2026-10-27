---
title: Gmail connects over IMAP with a Google app password; the gateway takes no OAuth client declared by an administrator
status: accepted
date: 2026-10-24
author: Renaud Pelissier (product owner), drafted with Claude
---

# Gmail connects over IMAP with a Google app password; the gateway takes no OAuth client declared by an administrator

## Context

Gmail connected through an OAuth client declared by an administrator of each instance and failed
with `redirect_uri_mismatch`: Google accepts no wildcard redirect and no dynamic registration, so
each instance needed a client registered by hand at its exact public URL. A client shared by every
instance is impossible too: Gmail's restricted scopes need Google verification and a yearly CASA
assessment a self-hosted Apache-2.0 gateway cannot carry. A person can create an app password alone
(with 2-Step Verification), and Gmail's IMAP extensions cover every modelled tool.

## Decision

The `gmail` plugin is kind `api-key` (address and app password) and runs its tools over IMAP; it
never sends mail. The instance has no administrator-declared OAuth client anywhere: an `oauth2`
spec declares either `clientRegistration` (the gateway registers itself) or `broker`
([google-calendar-through-an-oauth-broker](google-calendar-through-an-oauth-broker.md)).

## Consequences

- Gmail connects with no Google Cloud project or redirect URI; a public URL change breaks nothing.
- An app password opens the whole mailbox: the classifier and the budget are the only narrowing,
  and revoking it is the owner's act at Google (`manualRevocation`).
- Workspace administrators can forbid app passwords, and IMAP must be on; a Gmail account
  connected by OAuth is an account to reconnect.
- Folders are found by SPECIAL-USE, never by localized name. Tools, limits and label rules:
  handbook [providers/gmail](../handbook/providers/gmail.md).

## Rejected alternatives

### One Google OAuth client per instance

What broke: a hand registration at the exact public URL, redone whenever it changes.

### One verified Google client shared by every instance, or a hosted relay

Restricted scopes need verification and CASA; the OSS gateway never sends a mailbox's tokens
through a third party.

### A service account with domain-wide delegation

Workspace only, and its key opens every mailbox of the domain.

### Keep the administrator-declared client for a future service

No service needs it; an unused path is code that lies.
