---
title: Gmail provider plugin
tracks:
  - plugins/gmail/src/
  - plugins/gmail/package.json
last_reviewed: 2026-10-27
---

# Gmail provider plugin — handbook

`@vaubaan/plugin-gmail`: reads, drafts and labels over IMAP (`imap.gmail.com:993`) with the
mailbox's app password; it never sends mail
([gmail-over-imap-with-an-app-password](../../decisions/gmail-over-imap-with-an-app-password.md)).
One resource, the mailbox; no environment. Rules common to every plugin:
[providers README](README.md).

## Start here

- [`src/classify.ts`](../../../plugins/gmail/src/classify.ts) — pure, fail closed; zoning,
  sensitive labels; [`src/q-parser.ts`](../../../plugins/gmail/src/q-parser.ts) and
  [`src/address.ts`](../../../plugins/gmail/src/address.ts) are its parsers.
- [`src/execute.ts`](../../../plugins/gmail/src/execute.ts) — `planOf()` checks every argument,
  then one IMAP session per call.
- [`src/transport.ts`](../../../plugins/gmail/src/transport.ts) — the `imapflow` session.

## Invariants

- **A refused call opens no IMAP connection**: execute re-reads every argument with classify's
  functions before the session.
- **A draft to someone outside the internal domains and allowlists is denied by the classifier**,
  before any risk is evaluated: `draft-to-zone-external-unbounded` stays `deprecated: true` because
  the loader refuses `acceptable_in_envs: []` and a mission could enumerate every id.
- **A search is bounded only** when it is a pure conjunction with a positive `from:` naming one full
  address; anything else (`OR`, parentheses, quotes, `from:support`, a domain) also costs
  `from-zone[unknown]` and `bulk-marker`. `get_thread` / `get_attachment` are always worst case (the
  sender is unknown before the fetch).
- **Sensitive labels cannot be opted into**: when the mailbox declares `sensitive_labels`, a thread
  fetch always touches `sensitive-label[*]`, and a search only escapes it with `-label:<l>` written
  for each declared label. Writing a label that is or may be sensitive lands on the fallback, which
  no preset offers.
- Zoning matches exactly, never by substring; a no-reply local part is `automated` only on an
  internal or allowlisted domain. An unconfigured mailbox zones every sender `unknown`. Discovery
  pre-fills no zoning list: `internal_domains` from a `gmail.com` address would make every Gmail
  sender internal.
- One string is one address (`addr` or `Name <addr>`); any other recipient shape denies. `TRASH`
  and `SPAM` are denied as labels: a deletion is not a label write.

## Traps

- Folders are found by SPECIAL-USE (`\All`, `\Drafts`), never by name: Gmail localizes
  `[Gmail]/All Mail`. The system container is found by structure, never by the name `[Gmail]`.
- A user label is addressed by its **name** over IMAP; a `STORE` to a missing label would create it,
  so the executor answers `not_found` first.
- `-label:legal` does not exclude a nested label upstream: the owner lists nested labels one by one.
- `imapflow`: an unhandled `error` event ends the process (a listener is set); no command may run
  inside a fetch (bodies are downloaded after); it is external to the Next build
  (`apps/gateway/next.config.ts`, `scripts/build-commands.mjs`).
- Untested against a real account: behaviour is taken from Google's IMAP extension docs and
  `imapflow`'s source.

## Outside the repo

- 2-Step Verification on, then an app password (16 letters); IMAP must be on, and "Show in IMAP" on
  for All Mail and Drafts. A Workspace admin can disable app passwords. No scopes, no expiry; the
  gateway cannot delete it (the app passwords page).
- The owner fills `internal_domains`, `allowlist_addresses`, `allowlist_domains`,
  `sensitive_labels` on the account page.

## Debug

- Search refused on `read-from-zone-unknown` / `bulk-read` → not bounded by `from:<full address>`.
- Read refused on `read-sensitive-label` → add `-label:<name>` per declared label, or accept it.
- Draft refused on `draft-write` → it needs both `draft-write` and a `draft-to-zone-*` risk.
- `Gmail refused the IMAP sign-in of …` → wrong or revoked app password, disabled by the admin, or
  IMAP off.
- `folder_not_found` → Gmail settings, Labels, "Show in IMAP".
- `unsupported_label` → `SENT`, `DRAFT`, `CHAT`, `CATEGORY_*` are not writable over IMAP.
- `identifiers of plugin 'gmail'` … `execute sends 1 request(s)` → a tool opened a session before
  refusing an argument: move the check into its `plan*` function.
