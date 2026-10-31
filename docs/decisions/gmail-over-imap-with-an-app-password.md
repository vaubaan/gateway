---
title: Gmail connects with a Google app password, reading over IMAP and sending over SMTP; the gateway takes no OAuth client declared by an administrator
status: accepted
date: 2026-10-31
author: Renaud Pelissier (product owner), drafted with Claude
---

# Gmail connects with a Google app password, reading over IMAP and sending over SMTP

## Context

Gmail connected through an OAuth client declared by an administrator of each instance and failed
with `redirect_uri_mismatch`: Google accepts no wildcard redirect and no dynamic registration, and a
client shared by every instance needs Google verification and a yearly CASA assessment a self-hosted
Apache-2.0 gateway cannot carry. A person can create an app password alone (with 2-Step
Verification); it signs in to both Gmail's IMAP and its SMTP submission server, and agents need to
send mail, not only to draft it.

## Decision

The `gmail` plugin is kind `api-key` (address and app password): it reads, drafts and labels over
IMAP and sends over SMTP (`smtp.gmail.com:465`, implicit TLS) with the same app password. A send is
classified by the zone of its recipients like a draft, and is checked whole before any connection
opens. The instance has no administrator-declared OAuth client anywhere: an `oauth2` spec declares
either `clientRegistration` or `broker`
([google-calendar-through-an-oauth-broker](google-calendar-through-an-oauth-broker.md)).

## Consequences

- An app password opens the whole mailbox and its sending: the classifier and the budget are the
  only narrowing, and revoking it is the owner's act at Google (`manualRevocation`).
- A sent message cannot be called back: every send risk is its own catalog entry per recipient
  zone, in no preset; a refused send opens neither an IMAP nor an SMTP connection.
- Gmail files the sent copy in Sent itself; the plugin never appends one. Folders are found by
  SPECIAL-USE, never by localized name. Tools, limits and traps: handbook
  [providers/gmail](../handbook/providers/gmail.md).

## Rejected alternatives

### One Google OAuth client per instance, or one verified client shared by every instance

A hand registration at the exact public URL, redone whenever it changes; or restricted scopes with
verification and CASA, and a mailbox's tokens through a third party.

### A service account with domain-wide delegation

Workspace only, and its key opens every mailbox of the domain.

### Drafts only, sending left to the person

The product needs agents that send (Renaud, 2026-10-31); a draft nobody sends is the one step the
agent was given.

### Sending through the Gmail API or a relay such as Resend

The API needs the OAuth client rejected above; a relay sends from another domain, outside the
mailbox's Sent and threads.
