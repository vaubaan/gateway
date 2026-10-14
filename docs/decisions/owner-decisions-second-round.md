---
title: Product owner's decisions, second round (2026-10-14) — what changes, and what stays as it is
status: accepted
date: 2026-10-14
---

# Product owner's decisions, second round (2026-10-14) — what changes, and what stays as it is

> After the independent review of the redesigned interface
> (`r3-review`, "What needs the owner's decision") and the questions left by the
> redesign steps, the product owner took each recommendation as a decision. The
> structural one has an ADR of its own
> ([mission-limits-editable-after-issuance](mission-limits-editable-after-issuance.md));
> this record holds the others, so that nobody reopens them for want of a trace.
> First round: [owner-decisions-of-2026-10-13](owner-decisions-of-2026-10-13.md).

## Context

Some questions asked for a change; most asked "is this what we want?" about a
behaviour that already existed. A behaviour kept on purpose looks exactly like
one nobody thought about unless the reason is written down.

## Decision

### Changed

- **D1. A mission's limits can be changed after creation** by its creator — see
  [mission-limits-editable-after-issuance](mission-limits-editable-after-issuance.md).
- **D2. A machine key is replaced in one server act.** The store retires the
  named token and issues the new one of the same name in one transaction; one
  `mission-rotated` entry, one `rotation` event. The page no longer revokes then
  creates (which could leave the name free, or the machine keyless, if the second
  request failed). The old key is answered `token-rotated`. The dialog says what
  Replace key says: the old key stops at once.
- **D3. A teammate may leave a mission by themselves.** Membership and key end
  in one transaction (the same store act as a removal), the key is answered with
  the existing reason `holder-removed` — spec §4.1 lists four reasons and leaving
  is a removal by oneself, so no fifth is needed — and one `mission-member-left`
  entry names the teammate as the actor. Typed confirmation on the page. The
  creator cannot leave; they stop the mission.
- **D4. No shipped preset carries `supabase.read-managed-schemas`.** Supabase's
  `staging-developer` no longer does; a person may still tick it. Catalog 5,
  plugin 4.1.0.
- **D5. Rewording a catalog's prose is a change of its content**: each catalog
  reworded by the commit "prose outside the pages follows the interface words"
  takes its `catalog_version` bump (the open question of
  [prose-outside-the-pages-follows-the-interface-words](prose-outside-the-pages-follows-the-interface-words.md)
  is closed there).
- **D6. Green is for ticks only.** Success callouts and toasts say "done" in the
  accent, not in green.
- **D7. After disconnecting an account, what to do at the service is said
  once.**
- **D8. Supabase's `/v1/oauth/revoke` was checked** against Supabase's API
  description (the handbook of the plugin records what it says and that Context7
  had no entry): the request the host sends is the one Supabase specifies.
- **D9. The argon2id check of legacy tokens stays until the next major
  version** ([mission-token-sha256-digest](mission-token-sha256-digest.md), D5;
  `known-limitations`).

### Kept as they are

- **K1. No grace period on Replace key.** Cutting the old key at once is safer:
  a key one suspects leaked must stop now, and two keys of one holder working
  together would make the activity ambiguous. The dialog says the old key stops
  at once; the mockup's "keep it working for an hour" option is not built.
- **K2. No Approve from Now.** A yes is given where the arguments are shown —
  the request's own page. Now offers Review, and Refuse (which runs nothing).
- **K3. No louder retention warning.** Pilot instances start empty; the
  CHANGELOG states the 90-day default and where to change it.
- **K4. A teammate sees the tool and the resource of a pending approval on a
  shared mission, never its arguments nor their fingerprint.** Enough to know
  what waits and for whom; the arguments stay with who answers.
- **K5. The optional plugin field `toolTitles` stays.** A plugin may give a tool
  a sentence for people; without one the page falls back to the tool's name.
- **K6. The `/admin/**` paths stay.\*\* They are protocol-adjacent (bookmarks,
  reverse-proxy rules) and only administrators reach them; the navigation already
  says "Settings → Administration".
- **K7. Activity export, the whole-result count and a search field wait until
  after the pilot.** The filters answer the pilot's questions; export needs a
  decision on what leaves the instance.
- **K8. A teammate's Now does not list the creator's pending request.** It is
  not theirs to answer, and "nothing needs you" must stay true; the mission page
  shows the teammate what waits and for whose answer.

## Consequences

- The limit-reached page leads to the mission's limits instead of a copy of the
  mission.
- Three new administrative acts or uses: `limits-changed`, `mission-member-left`,
  and `mission-rotated` for a machine key.
- The spec needs §3.2, §3.4, §4.2, §7.8 and §7.9 bis to say D1–D3; the patch is
  handed to the planning step, as the coding step does not edit `docs/spec/`.

## Rejected alternatives

- **A fifth 401 reason `holder-left`.** The agent's instruction for
  `holder-removed` ("its member was removed from the mission") is the right one,
  and the administrative entry already says who acted.
- **Keep the revoke-then-create replacement of a machine key.** Its failure in
  the middle leaves the machine without a key and the name free for anyone.
- **Keep `read-managed-schemas` in `staging-developer` because queries calling
  application functions are refused without it.** The refusal names the missing
  permission; reading identities and secrets is a choice a person makes on
  purpose, not a default.
