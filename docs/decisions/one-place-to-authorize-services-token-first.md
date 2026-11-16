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

## Amendment 2026-11-11: a token scoped to one project is accepted too

### Context

On 2026-10-31 (PR #159) the Vercel way refused a token scoped to one project: grant wide at the
service, the mission narrows. Some owners will not hand a team-wide token to a gateway, and the
refusal blamed the Team ID for what was the token's scope.

### Decision

The owner (Renaud Pelissier) reverses that refusal: where a service makes a key either wide or
confined to one resource, the plugin offers both as alternatives of its one way (amendment
2026-11-11 of [plugin-contract-and-credential-spec](plugin-contract-and-credential-spec.md)). The
guide still recommends the wide grant first and says why; the narrow alternative confines the
account to that resource, and the missions narrow inside it. Vercel is the first: "Team" (token +
Team ID) or "One project" (token + Project ID).

### Consequences

- One way per plugin still holds: one credential spec, one `verify`, one execute; the plugin reads
  the mode from the field the host kept, so connections made before need no migration.
- A narrow account discovers its one resource only; a mission needing another one needs another
  account (or a wide one).
- `verify` tells the two failures apart: a token that does not cover the whole team is told to
  choose the narrow alternative, a team id the service does not know is said so.

### Rejected alternatives

#### Keep refusing narrow tokens

Blocks owners whose policy forbids a team-wide token, for a breadth the gateway does not need.

#### A second plugin (`vercel-project`)

Two catalogs, two pages and two sets of tests for one service.

## Amendment 2026-11-13: the repositories the missions will use

### Context

GitHub's guide asked for "All repositories" of the resource owner. A token over every repository of
an organisation is wider than any mission, and the person creating it hesitates or refuses.

### Decision

The owner (Renaud Pelissier) reverses the wide grant where the token lets the person pick the
resources it reaches: the guide says to pick the ones the missions will use, not everything; the
permissions are still all ticked, and each mission narrows further. GitHub applies it now ("Only
select repositories"); the other guides keep their wide grant until each is reviewed.

### Consequences

- Discovery lists only what the token reaches, so a repository left out is not a resource of the
  account; a mission needing it means a new token (or an edited one at GitHub) and a reconnect.
- The connect page lists each permission by name and access only, without the tools it serves:
  the person is configuring a service there, not reading the detail of each permission.

### Rejected alternatives

#### Keep "All repositories"

A token over every repository of an organisation is wider than any mission and frightens the
person who creates it; the second visit it saves is rare next to the token it costs.

## Amendment 2026-11-14: the narrowest key that fits the missions first

### Context

Where a service makes a key either wide or confined (Vercel: a team, or one project), the guide
recommended the wide key first (amendment 2026-11-11). That ordering invites one giant key that
every mission of every project points to: a leak or a mistake there reaches everything, and every
mission depends on that one key.

### Decision

The owner (Renaud Pelissier) keeps both keys and forbids neither, but reverses the order: where a
plugin declares alternatives, it lists **the narrowest key that fits the person's missions first**
and the wide key after it, and the guide's reach says why in one sentence on the connect page: a key
per project keeps a leak or a mistake inside that project; one key for everything makes every
mission depend on it. Vercel applies it now ("One project", then "Team"). Nothing is enforced: the
person chooses, and the first alternative is only the one checked when the page opens.

### Consequences

- The connect page and the site's plugin page show the alternatives in the plugin's order; the
  first one is checked by default. Connections made before need nothing: the mode is still read
  from the field the host kept.
- A person with several projects connects several narrow accounts (one per project) or chooses
  the wide key knowingly; a mission still takes one account per service.
- The 2026-10-31 wide grant still holds where the service offers no such choice (the permissions of
  one key); the 2026-11-13 rule still holds where the token picks its resources.

### Rejected alternatives

#### Forbid the wide key

Blocks the owner who runs one team for one product, for whom the wide key is the narrowest that
fits.

#### Keep the wide key first

The default a person accepts without reading becomes the key every mission depends on.

## Amendment 2026-11-16: one GitHub repository per account

### Context

A fine-grained GitHub token always reads every public repository, and GitHub gives it no way to
list the repositories it was granted: discovery (`GET /user/repos`) listed every repository of the
user, a dozen where the token was made for one. Hiding the public ones by default (2026-11-14) left
a page full of repositories the account cannot act on.

### Decision

The owner (Renaud Pelissier) makes **one GitHub account one repository**: the connect form asks
the token and the repository (`owner/repo`), the check at paste opens it, and that repository is
the account's one resource. Another repository is another account, with its own token. Accounts
made before keep the former listing until reconnected; no migration.

### Consequences

- A mission takes one account per service, so it reaches **one GitHub repository**: an agent
  working on two repositories needs two missions. Accepted knowingly.
- A leaked or misused token reaches one repository.
- A call naming a repository of no account of the mission is rejected by the plugin's reader
  (audited, no `resource-not-in-mission` refusal, since the ref is no resource of the account).
- The git remote keeps one URL per repository (`/git/github/<owner>/<repo>.git`).

### Rejected alternatives

#### A list of repositories on the form

Fixes the listing and keeps several repositories per mission, but keeps one token over several
repositories; the owner prefers one key per repository.

#### Keep `/user/repos` and hide public repositories

The page still lists what the token cannot act on, and a public repository in the grant must be
shown by hand.
