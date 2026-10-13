---
title: The home reads one model, a yes is given only where the call is shown, and the answers keep the protocol's
status: accepted
date: 2026-10-14
---

# The home reads one model, a yes is given only where the call is shown, and the answers keep the protocol's

> Step R2a of the interface redesign (ADR
> [interface-redesign-vocabulary-and-design-system](interface-redesign-vocabulary-and-design-system.md)):
> the home "Now", "Waiting for you", the page of one request, the first run, the
> sign-in and the pages around the application. Handbooks:
> [web-app](../handbook/web-app.md), [requests](../handbook/requests.md).

## Context

The cold audit found three pages competing for "home", requests reachable only
through a badge, and a request page that listed facts without an order. The
mockups of proposal D answer with one home that shows what waits and what
runs, an inbox with one request open beside its list, and inline answers on
the home.

Four things the mockups draw do not exist in the gateway as they are drawn:

1. **Who asks.** A request row names its mission, not the caller. The mockup
   says "codex using Carol's key".
2. **A sentence for the call.** The mockup's statement is "Merge pull request
   #418 into main on acme/web". The gateway knows a tool name, arguments it
   keeps sealed, and the catalog label of the permission.
3. **"Raise the limit to 10,000 per day"** as an answer to a limit that was
   reached. The service accepts four answers to a claim, none of which edits
   the policy (ADR
   [claim-resolutions-as-counter-credits](claim-resolutions-as-counter-credits.md)).
4. **"Approve" on the home**, beside a one-line description.

And one thing the redesign brief asks that the mockup does not draw: the
person must read what answering changes **before** they answer.

The consent screen of the authorization endpoint and the refusals of the
forwarded request URL are HTML strings sent under `default-src 'none'`; they
cannot load the style sheet of the application and looked like another
product.

## Decision

1. **One read model for the home, and it adds no rule.** `readNow`
   (`server/now`) composes `MissionService.list`, `RequestService.waiting`,
   `ConnectionService.listFor`, `ShareService.received` and the audit's
   per-holder activity. Each of those already decides who sees what. The page
   renders the model and decides nothing. No store query was added.
2. **Who asks is read from the session.** The refused call is a
   `call-refused` event that carries the `request_id`, the authenticated
   holder of the token and the label the agent gave itself; `askedBy` reads
   the first one. The holder is printed as a fact, the label as a claim.
3. **The statement of an approval is the catalog label of the permission(s)
   it needs**; the tool is printed beside it as the protocol spells it, and
   the arguments each by its name. The gateway does not compose a sentence
   from arguments: it would have to understand every tool of every plugin,
   and a wrong sentence above a yes is worse than none.
4. **A yes is given only on the page that shows the call.** On the home the
   row of an approval offers "Review" (a link to the request) and "Refuse" (a
   form post: a refusal runs nothing). The arguments of a call are opened in
   one place, for the creator, and an approval binds to exactly those
   arguments (spec §3.5): approving from a row that cannot show them would
   make the binding a formality.
5. **What an answer does is stated before the answers**, in the page's words,
   keyed by the protocol's resolution and — when an answer is not possible —
   by the code of its problem. The order on the page is: who asks, on which
   mission, the call and its arguments, the permission and its severity, the
   room left, what each answer does, the answers; context comes after.
6. **The answers stay the protocol's.** An approval: `grant`, `open-gate`,
   `refuse`, said "Approve this call", "Let it run freely until the reset",
   "Refuse". A limit: `reset-period`, `extend-quota`, `extend-expiry`,
   `refuse`, said "Reset the count", "Give back some calls", "Extend the
   mission", "Leave it until the reset". Raising a limit for good is an edit
   of the mission: the page links to it and does not offer it as an answer.
7. **Counts on the home are windows of time** — calls in the last 24 hours,
   refusals in the last hour — not calendar days: the server does not know
   the reader's time zone, and a mission's period starts when it was created,
   not at midnight.
8. **When nothing waits the home is one sentence**; what is running is one
   click away and the page remembers the click. Someone who created no
   mission reads the model and the steps instead.
9. **The self-contained documents share one builder** (`server/http/document.ts`)
   that repeats the tokens they need, value for value, in both themes; a test
   keeps them equal to the token sheet. The handler passes the theme the
   person chose (the application's cookie), so the document arrives in it
   without a script. Their content policy and their headers are unchanged;
   "Deny" stays the first button of the consent form.

## Consequences

- The home costs a handful of indexed reads per mission the person can read.
  It lists a person's missions, not the instance's; a hosted variant with
  thousands of missions per person would want a counts query in the store.
- A request whose session events were purged by retention has no named
  asker: the page says "An agent". Nothing is guessed.
- The statement of an approval is as good as the catalog's labels. A label
  written as a pattern ("Write on main / master / release-\*") reads as one.
- Approving takes one click more than in the mockup: the home leads to the
  request. Refusing does not.
- The words of an option (`label`, `consequence`, `unavailable.message`)
  still exist in `claim.ts` and `approval.ts` and are still tested there; the
  pages no longer print them. They are what a JSON client of
  `/api/requests` reads.
- `RequestService` gained two reads (`waiting`, `answered`) and its views two
  facts (`asker`, the period length; `approval_valid_seconds` for an
  approval). `SessionEventLine` carries the stored details of its event so
  that a page words it; details never hold arguments.
- The tokens exist in two places. The test that compares them fails when one
  moves without the other.

## Rejected alternatives

- **"Approve" on the home**, as drawn. Rejected for the reason of point 4.
  Showing the arguments on the home to make it safe would put sealed
  arguments on the page a person opens most, in a list.
- **A "raise the limit" answer** that edits the mission's policy from the
  request. It would be a second way to edit a policy, outside the mission
  page and its checks, and it reopens the question the claim ADR closed.
- **Rewording the options in the server** (`LABELS`, the consequence
  sentences). They are part of what the request API answers; changing them
  for the interface would change them for every client. The interface owns
  its words (`lib/vocabulary.ts`), keyed by the protocol's names.
- **A new store query for "answered today" and for the counts.** The existing
  reads suffice at the size of one person's missions; a query is the right
  answer when that stops being true, not before.
- **Calendar days from the server's clock** ("1,212 calls today"). Wrong for
  anyone not in the server's time zone, and unrelated to when a limit resets.
- **Loading the application's style sheet from the consent screen.** It would
  mean relaxing `default-src 'none'` on the one page where a person hands an
  agent part of their authority.
- **A global density setting** for the home. Already rejected by the design
  system ADR: detail is per page and remembered.
