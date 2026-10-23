---
title: The accounts without owner are a region of Accounts, not a page of Administration
status: accepted
date: 2026-10-23
---

# The accounts without owner are a region of Accounts, not a page of Administration

> Decided on the owner's review of the Settings pages (2026-10-23). Handbooks:
> [authority](../handbook/authority.md) ("Accounts without owner"),
> [web-app](../handbook/web-app.md) ("Settings"). Spec:
> [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2 "Administration". Earlier
> decision on the subject itself:
> [orphaned-missions-and-ownerless-connections](orphaned-missions-and-ownerless-connections.md).

## Context

An account whose owners all left (the last member of its team removed, its owner
deactivated) keeps serving its missions, but nobody can reconnect it or give access to
it until an administrator names a new owner — the administrator's only act on an
account. Since the redesign this list was a page of Settings → Administration,
"Accounts without owner" (`/admin/connections`), one of ten entries of the local
navigation, empty almost always ("Every account has an owner.").

The owner's review found it odd: an administrator looking for an account looks at
Accounts, and a Settings page that is empty almost always is an entry spent on an
exception. The style guide agrees twice: at most seven navigation entries, and "a page
shows the exception and not the rule".

## Decision

1. **The list is the last region of Accounts (`/accounts#without-owner`)**, rendered by
   `components/connections/OwnerlessAccounts.tsx`, **for an administrator only, and
   only when at least one account has no owner.** The region keeps the table (the
   account, who owned it, its state) and the form under each row (a person by email,
   or a team that has members), and says in its hint that the reader administers the
   gateway and that nothing else of these accounts is reachable from here.
2. **Settings loses the entry.** The setup checklist keeps its line — it appears only
   when an account needs an owner — and its button leads to the region by its anchor.
   `OWNERLESS_CONNECTIONS_PAGE` is that address; the reassign handler redirects there
   with its notice, which the Accounts page shows at its top.
3. **The old address redirects.** `/admin/connections` is a legacy redirect of
   `next.config.ts` to the region (no page: every page of Administration must
   authorize, and a redirect is not a page); `POST /admin/connections/<id>/reassign`
   stays where it is (`REASSIGN_PATH`), operator-only as before.

## Consequences

- An administrator sees, on the page that lists accounts, the ones nobody owns, and
  nothing when there is nothing to do. A person who does not administer sees no
  change: the service calls that list the ownerless accounts and the teams run for an
  operator only.
- The Settings navigation has nine entries for an administrator. The e2e shell test
  and the ownership-loop test follow; the demo tour and the handbooks name the region
  instead of the page.
- An audit entry, a refusal and the service layer are untouched: this is a move of the
  surface, not of the rule.

## Rejected alternatives

- **Keep the page and show it only when needed.** A navigation entry that comes and
  goes is harder to find than a region on a page the administrator reads anyway.
- **An "Administration" region on Accounts with every operator act.** There is only
  one operator act on an account; a region named for the act is clearer than a region
  named for the role.
- **Show the region to every person, read-only.** The owners who left are not a fact
  the other people need; it would spend attention on everyone's page for an act one
  person can take.
