---
title: Gmail connects over IMAP with a Google app password; the gateway no longer takes an OAuth client declared by an administrator
status: accepted
date: 2026-10-24
author: Renaud Pelissier (product owner), drafted with Claude
amends:
  - plugin-contract-and-credential-spec
  - one-place-to-authorize-services-token-first
  - oauth-client-registered-by-the-gateway
  - setup-checklist-lists-only-what-is-needed
---

# Gmail connects over IMAP with a Google app password; the gateway no longer takes an OAuth client declared by an administrator

> Decided by the product owner on 2026-10-24, after the Gmail connector failed
> with Google's `Error 400: redirect_uri_mismatch`. Spec:
> [vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §4.3, §5, §7.1, §7.2.
> Handbooks: [providers/gmail](../handbook/providers/gmail.md),
> [connections](../handbook/connections.md), [plugin-sdk](../handbook/plugin-sdk.md).

> **Amended on 2026-10-24** (same day, before merge): HTML bodies, attachments,
> label names with spaces and accents, and `gmail__create_label` with the new
> risk `gmail.label-create` (catalog 5). See "Amendment of 2026-10-24" below.

## Context

Gmail was the one plugin that connected through an OAuth client **declared by
an administrator** of each instance (ADR
[one-place-to-authorize-services-token-first](one-place-to-authorize-services-token-first.md)):
the company registered a Google Cloud OAuth client whose redirect URI is
`<public_url>/connections/callback/gmail`, and entered its id and secret on
Gmail's connect page or under `providers.gmail.*` in the configuration. The
plugin itself was classifier-only: no tool was exposed and `execute` answered
`not_implemented`.

In use, the flow broke on `redirect_uri_mismatch`. Google accepts no wildcard
redirect URI and no dynamic client registration, so every instance needs its
own client, registered by hand at Google with the exact public URL, re-edited
whenever that URL changes, and its consent screen configured. One client
shared by every instance is not possible either: a client is bound to its
redirect URIs, and a shared client asking for Gmail's restricted scopes
(`gmail.readonly`, `gmail.compose`, `gmail.modify`) must pass Google's
verification and a yearly third-party security assessment (CASA), a cost and a
process a self-hosted, Apache-2.0 gateway cannot carry for its users.

Google offers a second way into a mailbox that a person can set up alone: an
**app password** (16 letters, created at myaccount.google.com/apppasswords once
2-Step Verification is on) that signs in over **IMAP**. Gmail's IMAP server
exposes its own extensions (`X-GM-EXT-1`): Gmail search syntax (`X-GM-RAW`),
stable thread and message ids (`X-GM-THRID`, `X-GM-MSGID`, the numbers the
Gmail API prints in hexadecimal) and labels (`X-GM-LABELS`). Every tool the
classifier already models has an IMAP equivalent, and none of them needs
SMTP.

With Gmail gone from OAuth, the "OAuth client declared by an administrator"
mechanism has no user left: Miro, the other `oauth2` plugin, uses a client the
gateway registers itself (ADR
[oauth-client-registered-by-the-gateway](oauth-client-registered-by-the-gateway.md)).

## Decision

### D1 — Gmail connects with an app password, over IMAP

The `gmail` plugin's one way of connecting is the SDK kind `api-key` with two
fields: `email` (the Gmail or Google Workspace address) and `app_password`
(secret; the 16 letters, with or without the spaces Google prints, which are
stripped). The connect page shows a guide: turn on 2-Step Verification, open
the app passwords page, create one named "Vaubaan Gateway", paste it. The
guide says that a Workspace administrator can disable app passwords and that
IMAP must be on in Gmail's settings when the account has it off. An app
password carries no scope choice: `permissions` is empty and the steps say so;
it does not expire (`recommendedExpiryDays: null`). `verify` signs in over
IMAP and returns the address as the account; a refused sign-in is an
`UpstreamAuthError`. The OAuth credential of the plugin is removed; no OAuth
alternative is kept.

### D2 — The classified tools execute, over IMAP, and never send

`imap.gmail.com:993`, implicit TLS, one connection per call, the call's
`AbortSignal` and a deadline honoured, through an injectable transport (as the
SSH plugin's), with `imapflow` (MIT) as the client. Folders are found by
**SPECIAL-USE** (`\All`, `\Drafts`, as the server reports them), never by name:
Gmail localizes them. Mapping:

| Tool                    | IMAP                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `search_threads`        | `X-GM-RAW <q>` in `\All`, grouped by `X-GM-THRID`, `max_results` capped                     |
| `get_thread`            | search by `X-GM-THRID` in `\All`; headers and a capped plain-text body per message          |
| `list_drafts`           | the `\Drafts` folder                                                                        |
| `create_draft`          | an RFC 5322 message built by the plugin, APPENDed to `\Drafts` with `\Draft`; no SMTP       |
| `list_labels`           | LIST: the system labels the plugin maps, plus the user labels (folders without SPECIAL-USE) |
| `label_*` / `unlabel_*` | STORE `±X-GM-LABELS` (`UNREAD`: `∓\Seen`); `TRASH` / `SPAM` stay refused                    |
| `describe_zones`        | synthetic, as before                                                                        |

Thread and message ids are the lower-case hexadecimal of `X-GM-THRID` /
`X-GM-MSGID`, the ids of the Gmail API. The classifier's grammar of an id
(`gmailId`) is narrowed to that form, 1 to 16 hexadecimal digits, and execute
takes its ids and labels from the classifier's grammar functions only (ADR
[plugin-identifiers-one-grammar-for-classify-and-execute](plugin-identifiers-one-grammar-for-classify-and-execute.md)).
A label is addressed by its **name** (as `list_labels` returns it), which is
what the classifier's sensitive-label rules already compare; the system ids
`INBOX`, `STARRED`, `IMPORTANT` and `UNREAD` map to `\Inbox`, `\Starred`,
`\Important` and the `\Seen` flag; a user label must be listed by the server
and carry no SPECIAL-USE, so no write can create a label or reach a system
folder by a localized name. The subject and the addresses of a draft never
carry CR or LF. The risk catalog, its ids and its presets do not change.

### D3 — No OAuth client declared by an administrator, anywhere

Removed from the gateway: `appConfigFields` of the SDK's `oauth2` spec, the
`ProviderAppConfig` a plugin received as `ctx.appConfig`, the provider-apps
service and its `instance_config` keys `provider_apps.*` (deleted by a
migration), the configuration keys `providers.<id>.*` and
`VAUBAAN_PROVIDER_<ID>_<FIELD>` (no longer read; an instance that still sets
them starts and logs a warning naming them), the OAuth client form of a
connect page, the setup checklist's "OAuth clients" step and the management
door's `setup.company_apps`, and the administrator route
`POST /admin/provider-apps/<provider>`. An `oauth2` spec now **must** declare
`clientRegistration` (`definePlugin` refuses one that does not): the only OAuth
client the gateway knows is one it registers itself. The OAuth flow Miro needs
— `clientRegistration`, `OAuth2Clients`, `/connections/callback/<id>` — stays.

### D4 — A Gmail account connected by OAuth is an account to reconnect

A stored `oauth2` Gmail connection is an account made a way the plugin no
longer offers, handled by the rule already in place for such accounts: its
tools are not offered and a call is refused naming the reason and "its owner
reconnects it from Accounts"; a discovery says the same without calling the
plugin; the account page names the way as one this gateway no longer offers;
reconnecting it with an app password keeps the connection's id, its resources
and its shares. Nothing crashes on the stored secret and nothing is withdrawn at
Google: the owner removes the old grant in their Google Account.

## Consequences

### Positive

- Gmail connects in two minutes without an administrator, a Google Cloud
  project, a consent screen or a redirect URI; a public URL change breaks
  nothing.
- Gmail's tools run: an agent can search, read, draft and label under the
  identity-zoned risks the catalog already prices.
- No send path exists in the plugin: IMAP cannot send, and no SMTP client is
  shipped.
- The gateway loses one notion (a client declared by an administrator), its
  form, its settings, its configuration keys, its audit entries and its setup
  step.

### Negative / constraints

- **An app password opens the whole mailbox** over IMAP, with no scope:
  everything a mission may do is decided by the gateway's classifier and
  budget alone, never narrowed by Google. The password is stored encrypted
  like every key; revoking it at myaccount.google.com/apppasswords is the
  owner's act (`manualRevocation`).
- **A Workspace administrator can forbid app passwords**, and Google may keep
  narrowing them; such a mailbox cannot be connected. Accounts without 2-Step
  Verification cannot create one.
- **IMAP must be on** for the account (Gmail settings).
- **Labels are addressed by name**: a user label whose name holds a space or a
  character outside the classifier's label grammar cannot be written; Gmail's
  category tabs (`CATEGORY_*`) are not reachable over IMAP and are refused by
  execute.
- **Plain text only**: `get_thread` returns the text/plain part, capped; an
  HTML-only message shows its headers and no body. Attachments are not read.
- **Existing OAuth Gmail accounts must be reconnected** with an app password;
  instances that set `providers.gmail.*` see a warning until they remove it.
- **Not verified against a real Gmail account** when this was written: the
  transport is tested against a fake, the IMAP behaviour is taken from
  Google's documentation of its extensions and from `imapflow`'s.

## Rejected alternatives

### One Google OAuth client per instance (the previous way)

What broke: Google allows no wildcard redirect and no dynamic registration, so
each instance's administrator registers a client by hand at the exact public
URL, configures a consent screen, and fixes it whenever the URL changes. The
error the product owner met is the normal failure of that set-up, not a bug to
fix.

### One verified Google client shared by every instance

Impossible for a self-hosted gateway: a client's redirect URIs name its
instances, and Gmail's restricted scopes on a public client require Google's
verification and a yearly CASA assessment. It would also put one secret in
every instance. Reserved, if ever, to a hosted offer (below).

### A service account with domain-wide delegation

Workspace only (no personal Gmail), set up by a Workspace super-administrator,
and the key gives access to **every mailbox of the domain**, impersonating any
user: far wider than one mailbox per connection, and against the gateway's
model where a connection is one account its owner chose to delegate.

### A hosted relay with a verified client, operated by Vaubaan

Out of the gateway's scope: the OSS gateway knows nothing of a managed offer
and never sends a mailbox's tokens through a third party. A hosted offer may
make its own choice.

### Keep the administrator-declared OAuth client in the gateway for a future service

No service needs it today, and keeping an unused path (a service, a form, two
configuration sources, a setup step, an audit kind) is the kind of code that
lies. A future service with no key and no dynamic registration would bring its
own decision.

### Keep Gmail classifier-only, connected by app password

The connection would hold a credential that serves nothing. The tools map onto
IMAP one for one; executing them is what makes the risk model useful.

## Amendment of 2026-10-24 — HTML, attachments, label names, new labels (plugin 0.5.0, catalog 5)

> Asked by the product owner on review of the pull request, before merge: the
> read and label limits of D2 were too narrow. It replaces the two
> constraints "Labels are addressed by name" (the grammar part) and "Plain
> text only" above.

### D5 — An HTML-only message is read as text; attachments are listed and downloadable

- `get_thread` takes a message's first inline text/plain part and, when there
  is none, its first inline text/html part. At most 200 000 bytes of HTML are
  read (`MAX_HTML_BYTES`), converted to text by `html-to-text` (MIT, 10.0.1):
  link targets kept next to their words, `script`, `style`, `head` and images
  dropped, no wrapping. The text is capped at 20 000 characters, like a plain
  body (`MAX_TEXT_BYTES`). Each message lists its attachments (part number,
  file name, MIME type, decoded size estimated from the transfer size).
- `gmail__get_attachment { thread_id, message_id, part }` returns one listed
  attachment, base64-encoded, at most **5 MiB decoded** (`MAX_ATTACHMENT_BYTES`;
  about 6.7 MB of base64). A larger one is refused (`too_large`) by its listed
  size before any download, and again if the download passes the cap. `part`
  has its own grammar, `gmailPartId` (numbers from 1 separated by dots, at most
  4 digits each, 32 characters), shared by classify and execute. The message
  must belong to the thread the call was classified on.
- `get_attachment` is classified exactly like `get_thread`:
  `thread[t].message[m].R` (matched by `gmail.read-mailbox`),
  `from-zone[unknown].R`, and `sensitive-label[*].R` when the mailbox declares
  sensitive labels. No new risk.

### D6 — Label names as Gmail allows them

`labelRef` accepts letters, marks and digits of any script, the space and
common punctuation (`Clients 2026`, `Factures payées`, `Projets/Été`), at most
225 characters. It still refuses control characters (C0, C1, DEL, CR, LF),
quotes, backslashes, `*` / `%` (`LIST` wildcards), braces (an IMAP literal),
brackets, an empty, `.` or `..` segment, and blanks at either end of the name
or of a segment. A write still requires the label to be listed by the server
without a special use, and stores the server's own spelling (compared in
NFC). Sensitive-label matching compares in NFC, case-insensitively, a blank or
`/` as `-`; a name that is not a slice identifier is emitted as `*`. On the
wire, `imapflow` (2.4.0, verified in its source) sends a mailbox or label name
that is not a plain atom as a quoted string, escaping `"` and `\`, refuses CR,
LF and NUL, and encodes non-ASCII names in modified UTF-7 unless the server
enabled UTF-8: the grammar keeps those characters out anyway.

### D7 — `gmail__create_label`, a new write and a new risk

- `gmail__create_label { name }` sends `CREATE` of a user label, nested with
  `/`. The classifier (`creatableLabel`) refuses a system label id (`INBOX`,
  `TRASH`, `SPAM`, `CATEGORY_*`… as the first segment, any case) and anything
  under `[Gmail]` / `[Google Mail]`; execute refuses a name that exists (any
  case, NFC), a special-use folder, and anything under the system container
  (the parent of `\All`, found by structure).
- New risk **`gmail.label-create`**, matching `gmail.mailbox.label[**].W` (the
  slice grammar has R and W only; the name is the identifier, `*` when it is
  not a slice identifier). Before it, that slice matched only the fallback. A
  name that is, or is nested under, a sensitive label also emits
  `sensitive-label[l].W`, which only the fallback matches, so no preset can
  create a sensitive label.
- **Preset**: in `developer`, beside `gmail.label-write`, gate `auto`, quota 20
  per period, 5 per minute: creating a label moves no message and is undone in
  Gmail. Not in `read-only`.
- **`catalog_version` 5**: a risk was added. No id was renamed or deleted;
  `gmail.draft-to-zone-external-unbounded` stays deprecated and out of every
  preset.

### Consequences of the amendment

- An agent can read newsletters and invoices sent as HTML, and fetch an
  attachment up to 5 MiB; a larger attachment is out of reach.
- HTML conversion runs inside the gateway on content chosen by the sender:
  the parser is bounded by the 200 000-byte input cap; nothing is rendered or
  executed.
- Label names with spaces and accents work; names with quotes, backslashes,
  brackets or braces still cannot be written or created.
- Not verified against a real Gmail mailbox, as for the rest of this ADR.

### Rejected alternatives of the amendment

- **Return the raw HTML.** Larger, full of markup, tracking pixels and
  scripts an agent would read as text; the conversion keeps what a person
  reads, links included.
- **A hand-written tag stripper.** HTML parsing has many edge cases (entities,
  comments, malformed markup); a maintained parser is less code to trust.
- **Stream attachments of any size.** The MCP result is one JSON value held in
  memory by the gateway; a cap keeps a call's memory and the audit bounded.
- **Put `create_label` under `gmail.label-write`.** One risk would grant two
  different acts (tagging a thread, changing the mailbox's structure); a
  mission should be able to hold one without the other.

## References

- Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §0 "Connection", §4.3
  (configuration), §5 (plugins), §7.1, §7.2, §11.1.
- ADRs amended: [plugin-contract-and-credential-spec](plugin-contract-and-credential-spec.md)
  (D2: no `appConfigFields`, no `ProviderAppConfig`, `clientRegistration`
  required), [one-place-to-authorize-services-token-first](one-place-to-authorize-services-token-first.md)
  ("Gmail keeps the OAuth way" no longer holds),
  [oauth-client-registered-by-the-gateway](oauth-client-registered-by-the-gateway.md)
  (the registered client is the only kind left),
  [setup-checklist-lists-only-what-is-needed](setup-checklist-lists-only-what-is-needed.md)
  (the step and `setup.company_apps` are gone). Superseded long before:
  [company-apps-kept-where-they-add-something](company-apps-kept-where-they-add-something.md).
- Google: "Sign in with app passwords" (support.google.com/accounts/answer/185833),
  "IMAP Extensions" (developers.google.com/workspace/gmail/imap/imap-extensions).
- `imapflow` (MIT): imapflow.com.
