---
title: The setup checklist has no step for a service nobody asked for
status: accepted
date: 2026-10-23
amended-by:
  - gmail-over-imap-with-an-app-password
---

# The setup checklist has no step for a service nobody asked for

> **Amended on 2026-10-24** by [gmail-over-imap-with-an-app-password](gmail-over-imap-with-an-app-password.md): no OAuth client is declared by an
> administrator any more, so the checklist's "OAuth clients" step is removed,
> and so is the management door's `setup.company_apps` (point 3).

> Decided on the owner's review of the Settings pages (2026-10-23). Handbook:
> [authentication](../handbook/authentication.md) ("/admin — Setup"). Spec:
> [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2 "Administration", §7.2.
> Related: [one-place-to-authorize-services-token-first](one-place-to-authorize-services-token-first.md)
> (the OAuth client of a service is declared on its connect page).

## Context

The setup checklist (`/admin`) says what a fresh install needs, what is done and what
is left. One of its steps, "OAuth clients", listed every service that connects through
an OAuth client — since the token-first decision, Gmail alone — and, while none was
declared, read "**Gmail** is not: nobody can connect an account of it until it is",
with a "Declare Gmail" button and an unchecked mark that lowered the "n of m done"
count. A gateway where nobody uses Gmail stayed at "5 of 6 done" for good, and the
owner's review said it plainly: the gateway asked him to set up a service he never
asked for.

The connect page of a service already says what it needs: a service whose client is
not declared is listed on Accounts → Connect, dashed, "needs its OAuth client · declare
it" for an administrator, and the connect page carries the form.

## Decision

1. **While no OAuth client is declared, the checklist has no step for them.** The
   service's connect page is where the need is stated and met (spec §7.2), when
   somebody wants that service.
2. **Once one is declared, the step appears, done**, and says which clients are
   declared. A service whose client is still missing is named without alarm: "declare
   it from Accounts if your colleagues use it". The step never lowers the count.
3. The management door's `setup` view keeps `company_apps.missing`: an agent that
   prepares a gateway may want the list. The checklist a person reads is what changed.

## Consequences

- A fresh install without Gmail reads "n of n done" once sign-in, the key and the
  administrators are in place; nothing nags.
- The e2e shell test reaches the connect page of Gmail from Accounts instead of from
  the checklist; the assertion that the checklist has one primary button stands.
- A later service that connects through an OAuth client falls under the same rule
  without a code change.

## Rejected alternatives

- **Keep the step, not counted.** An unchecked mark that counts for nothing still
  reads as something left to do.
- **A step per service, "optional".** A checklist of optional steps is a list of
  services, which Accounts → Connect already is.
- **Drop the step even when a client is declared.** The declared clients are a fact of
  the setup worth reading in one place, and the step costs nothing once it is done.
