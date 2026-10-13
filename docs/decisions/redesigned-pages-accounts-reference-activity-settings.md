---
title: Accounts, Reference, Activity and Settings — what was folded, where a row's detail lives, what is asked first
status: accepted
date: 2026-10-14
---

# Accounts, Reference, Activity and Settings — what was folded, where a row's detail lives, what is asked first

> The choices made while rebuilding these pages on the design system (interface
> redesign, step R2c). The frame is ADR
> [interface-redesign-vocabulary-and-design-system](interface-redesign-vocabulary-and-design-system.md);
> the rules are the spec [style-guide](../spec/style-guide.md). Handbook:
> [web-app](../handbook/web-app.md).

## Context

The foundation step delivered the tokens, the components, the shell, the words and the
routes; the pages kept their earlier bodies. This step rebuilds the accounts and access
pages, the reference, the activity record, and Settings with the administration. The
mockups are the specification for the pages they draw; several things they leave open
had to be settled in code:

- two pages had no navigation entry any more and an old word in their path: `/shares`
  ("Shares received") and `/delegations`;
- the mockups unfold a row in place ("hide detail", "12 of 15 · show", a "why?"), and
  the pages are server components;
- the reference had four tabs — presets, risks, data model, tools — and every other
  page links into it by fragment (`#risk-<id>`, `#preset-<id>`, `#risks`, `#presets`);
- the audit of the first interface found a form that refused a key without saying the
  shape it expects, and destructive acts of the administration that happened on one
  click (deactivating a person, removing a member, disabling an app);
- the sentences a person reads after an act are written by the handlers, in the words
  of the spec.

## Decision

**Two pages are folded into the place a person looks for them.**

- What a colleague gave access to is the second region of **Accounts** ("Shared with
  you"). `/shares` answers with a permanent redirect to `/accounts`.
- Connected apps are a page of **Settings**: `/settings/connected-apps`, with the route
  that ends one under it. `/delegations` and `POST /delegations/<id>/revoke` answer with
  a permanent redirect (308: the post keeps its method). The server constant
  (`DELEGATIONS_PAGE`) and `ROUTES.connectedApps` are the same value, and a test holds
  them together.
- The pages of the administration keep their paths under `/admin/**`: only their
  titles, ledes and bodies change. The guard of the administration is tied to that
  directory, and nothing a person reads shows the path.

**"Give access" is a dialog over the page of the account**, at the address it had
(`/accounts/<id>/share`): the page renders itself and the dialog above it. The form
still posts to `POST /accounts/<id>/shares`, the confirmation of what an access would
bring back is still a second post, and a link to the dialog still works.

**The detail of one row lives in the address.** A row unfolds through a link that adds
a query parameter (`?open=<entry id>` on Activity, `?access=<id>` and `?resource=<id>`
on an account, `?app=<id>` and `?team=<id>` in Settings); the server renders the detail
under that row. No client state: the page stays a server component, a line of the
record can be sent to someone, and the back button closes what was opened. What is
remembered in the browser stays what the foundation defined — "show details" for a
region (`DetailScope`) and the folded help.

**The reference compares the permissions across the presets in one table.** The
"Presets" matrix and the "Risks" list were two readings of the same catalog; they are
one table now (a row per catalog entry, a column per preset), and "why?" unfolds what
the risk list showed. Three tabs remain: Permissions, Tools, How it is modelled. Every
earlier fragment still lands: `#presets` and `#risks` select Permissions, `#risk-<id>`
unfolds and marks its row, `#preset-<id>` marks its column, `#legend` opens "How to
read this page". The services are a local navigation beside the content.

**The activity record shows six columns** (the documented exception) and one more, the
mission, behind "Show details". Everything else about a line — the key, the permissions
touched and what is left, the fingerprint of the arguments, what the agent was told —
is in its detail. Who reads what, and who is shown the fingerprint, is unchanged and
still decided by `AuditQueryService`.

**An act that stops, removes or hands over something is asked first**, with its
consequence: removing an access, transferring an account, disconnecting an account
(typed), closing a stopped mission (typed), deactivating a person, removing someone
from a team, disconnecting an app, disabling a registered app. `ConfirmSubmit` is the
component: a dialog, then the same plain form post as before — the handlers, their
origin check and their audit entries do not change.

**A field says the shape it expects, read from the plugin's own pattern.**
`shapeOfPattern` reads the simple forms of `CredentialField.pattern` (a literal prefix
or a choice of prefixes, digits only, a length) and prints them in the label; a pattern
in any other form prints nothing. No field is added to the plugin contract.

**The sentences after an act are in the words of the interface.** The notices and the
refusals of the connections, shares, groups and users handlers, the notes of the
reference, and the prose a plugin ships for people (`summary`, `manualRevocation`, the
`help` of a field) say account, access, permission, team, administrator. Codes, ids,
field names, audit acts and catalog entries keep the protocol's names.

## Consequences

- No capability is removed: every act of spec §7 on these pages keeps a control, the
  list behind every count is one click away, and the per-service reference keeps every
  fact it had (the patterns of an entry, its per-environment profiles, its tools, the
  token hand-outs, the planes).
- Old links keep working through redirects, which the test of the routes holds to a
  page or a route that exists. A page written by another step that still links to
  `/delegations` or `/shares` works, at the price of one redirect.
- A row detail in the address means a navigation per unfold. The pages are small and
  rendered on the instance; the gain is a page that works without script and a line
  that can be linked.
- The reference lost a tab, not a fact; whoever looks for "Risks" finds "Permissions".
  The legacy explanation components (`RiskExplain`, `Slug`, `KindLegend`, `Help`) are no
  longer imported by these pages.
- The summary a plugin gives of itself now starts "One account is …"; the test of the
  reference holds that every shipped plugin says what an account and a resource are.
- The words of a notice changed, and with them the tests that quoted them. The audit
  holds no sentence, so no record changed.
- Two vocabularies still coexist, and the seam moved one step inwards: the handlers
  speak the interface's words in what a person reads and the protocol's in what they
  store and return to agents.

## Rejected alternatives

### Keep `/shares` and `/delegations` as pages, linked from where they belong

Two places for "which accounts can I use", and a page named after a word the interface
no longer says. The audit found exactly this: "Share" on an account against "Shares"
elsewhere, and what a person received listed apart from what they own.

### Move the administration under `/settings/**`

Tidier addresses, for a set of pages only administrators open. The guard, its tests,
the redirects of eight pages and their eight form routes would all move, to change a
path nobody reads.

### Unfold rows with client state

Closer to the mockup's "hide detail" (no navigation), but every list would become a
client component fed by serialisable rows, and the open state would be lost on reload
and impossible to link. The record of an audit is the place where a link to one line is
worth most.

### Keep the four tabs of the reference

It would have kept the matrix and the list side by side, one click apart, each
repeating the label, the id and the severity of every entry. The mockup draws one
table; a reader compares presets along a row and opens the reason from the same row.

### Add a `shape` field to the plugin contract

More exact than reading a pattern, and a change to every plugin for a sentence the
pattern already implies in the common cases. If a plugin needs to say more, its `help`
is under the field.

### Leave the handlers' sentences as they are

The pages would speak two languages one after the other: "Give access" on the button,
"Shared" in the note that follows.

## References

- Spec: [style-guide](../spec/style-guide.md) §1, §2, §5; [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2, §7.
- ADRs: [interface-redesign-vocabulary-and-design-system](interface-redesign-vocabulary-and-design-system.md),
  [owner-reads-missions-and-holders-of-a-connection](owner-reads-missions-and-holders-of-a-connection.md),
  [provider-reference-and-policy-modes](provider-reference-and-policy-modes.md).
- Handbooks: [web-app](../handbook/web-app.md), [connections](../handbook/connections.md),
  [authority](../handbook/authority.md), [audit](../handbook/audit.md),
  [management-door](../handbook/management-door.md), [authentication](../handbook/authentication.md).
