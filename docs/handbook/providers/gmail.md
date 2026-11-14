---
title: Gmail provider plugin
tracks:
  - plugins/gmail/src/
  - plugins/gmail/package.json
last_reviewed: 2026-10-31
---

# Gmail provider plugin — handbook

`@vaubaan/plugin-gmail`: reads, drafts and labels over IMAP (`imap.gmail.com:993`) and sends over
SMTP (`smtp.gmail.com:465`, implicit TLS), both with the mailbox's app password
([gmail-over-imap-with-an-app-password](../../decisions/gmail-over-imap-with-an-app-password.md)).
One resource, the mailbox; no environment. Rules common to every plugin:
[providers README](README.md).

## Start here

- [`src/classify.ts`](../../../plugins/gmail/src/classify.ts) — pure, fail closed; zoning,
  sensitive labels; [`src/q-parser.ts`](../../../plugins/gmail/src/q-parser.ts) and
  [`src/address.ts`](../../../plugins/gmail/src/address.ts) are its parsers.
- [`src/execute.ts`](../../../plugins/gmail/src/execute.ts) — `planOf()` checks every argument,
  then one IMAP session per call; `send_message` opens SMTP only, `send_draft` IMAP then SMTP.
- [`src/transport.ts`](../../../plugins/gmail/src/transport.ts) — the `imapflow` session;
  [`src/smtp.ts`](../../../plugins/gmail/src/smtp.ts) — the `nodemailer` send, one connection
  each, no pool.

## Invariants

- **A refused call opens no IMAP and no SMTP connection**: execute re-reads every argument with
  classify's functions before the session.
- **A send is zoned by its worst recipient**, Bcc included, into one `send-zone[..].W` slice:
  `send-to-zone-{self,internal,allowlist,external}`, external accepted like any risk (unlike a
  draft). 1 to 100 recipients. The four are in the `send` macro-action and in no preset.
- **`send_draft` is priced on the recipients its arguments declare**: execute reads the draft's
  envelope and refuses it unsent (`recipients_mismatch`) unless To, Cc and Bcc are exactly the
  declared ones. It relays the stored source byte for byte minus its `Bcc` header, then removes the
  draft from Drafts (`draft_removed: false` if that fails after the send).
- **Recipients go to SMTP as the envelope**, never re-read from headers; Bcc is never a header of
  what is sent. Gmail files the sent copy in Sent itself: nothing is appended.
- Nothing of an SMTP dialogue is logged: nodemailer's logger is off, a failure logs its class and
  the plugin's code only (ADR
  [provider-error-text-stays-with-the-agent](../../decisions/provider-error-text-stays-with-the-agent.md)).
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
  no macro-action offers.
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
- An SMTP sign-in refusal is the tool error `smtp_sign_in_refused`, never an `UpstreamAuthError`:
  a Workspace admin can block SMTP while IMAP works, and the account must not be marked to
  reconnect for it.
- `smtp_unavailable` (timeout, reset) after the data was handed over may still mean sent: the agent
  checks `in:sent` before sending again.
- Removing a sent draft expunges it from Drafts only; with All Mail shown in IMAP, Gmail's
  "When a message is marked as deleted…" setting decides whether a copy stays archived.
- Gmail's own limits (Workspace: 2 000 messages a day, 100 recipients per SMTP message; a consumer
  account sends fewer). Over the limit Gmail refuses every send for up to 24 hours; missions budget
  under it.
- A Workspace administrator can turn off app passwords, or SMTP for the domain: reads work, sends
  fail with `smtp_sign_in_refused`.
- Untested against a real account: behaviour is taken from Google's IMAP extension docs,
  `imapflow`'s and `nodemailer`'s docs. That Gmail SMTP files its own Sent copy comes from mail
  client documentation, not from Google's.

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
- `send_draft` answers `recipients_mismatch` → declare To, Cc and Bcc as `list_drafts` shows them.
- `smtp_sign_in_refused` while reads work → the admin blocks SMTP or app passwords for the account.
- `Gmail refused the IMAP sign-in of …` → wrong or revoked app password, disabled by the admin, or
  IMAP off.
- `folder_not_found` → Gmail settings, Labels, "Show in IMAP".
- `unsupported_label` → `SENT`, `DRAFT`, `CHAT`, `CATEGORY_*` are not writable over IMAP.
- `identifiers of plugin 'gmail'` … `execute sends 1 request(s)` → a tool opened a session before
  refusing an argument: move the check into its `plan*` function.
