# `@vaubaan/plugin-gmail`

Vaubaan Gateway provider plugin for Gmail. The plugin
models the risks of reading, drafting, sending and labelling in a mailbox,
and executes its fourteen tools over **IMAP** (`imap.gmail.com:993`, implicit
TLS) — the two sends over **SMTP** (`smtp.gmail.com:465`, implicit TLS) —
signed in with the mailbox's **app password**. Written against
`@vaubaan/plugin-sdk`, [`imapflow`](https://imapflow.com) (MIT),
[`nodemailer`](https://nodemailer.com) (MIT-0) and
[`html-to-text`](https://github.com/html-to-text/node-html-to-text) (MIT).
Maintainer handbook:
[`docs/handbook/providers/gmail.md`](../../docs/handbook/providers/gmail.md).
Decision: ADR
[`gmail-over-imap-with-an-app-password`](../../docs/decisions/gmail-over-imap-with-an-app-password.md).

## Data model

One plane, `mailbox`:

```
account → mailbox → label
                  → thread → message → attachment
                  → draft
                  → from-zone[automated | internal | known-external | unknown]   (synthetic)
                  → to-zone[self | internal | allowlist | external-unbounded]     (synthetic)
                  → send-zone[self | internal | allowlist | external-unbounded]   (synthetic)
                  → bulk-marker                                                   (synthetic)
                  → sensitive-label[<label>]                                      (synthetic)
```

Gmail zones by **identity**, not by containment: the risk of a read depends
on the sender, the risk of a draft or a send on its recipients. The five synthetic
entities are markers the classifier emits; the catalog matches them.

The **resource** a connection exposes is the authenticated **mailbox**
(`ref` = the lower-cased address of the credential, checked by an IMAP
sign-in).
Its `metadata` carries the zoning configuration the owner edits:

| Key                   | Type       | Drives                                                      |
| --------------------- | ---------- | ----------------------------------------------------------- |
| `account_email`       | `string`   | `to-zone[self]`, `send-zone[self]` (defaults to the ref)    |
| `internal_domains`    | `string[]` | `from-zone[internal]`, `to-` / `send-zone[internal]`        |
| `allowlist_addresses` | `string[]` | `from-zone[known-external]`, `to-` / `send-zone[allowlist]` |
| `allowlist_domains`   | `string[]` | `from-zone[known-external]`, `to-` / `send-zone[allowlist]` |
| `sensitive_labels`    | `string[]` | `sensitive-label[<label>]` on every read and label write    |

Discovery pre-fills nothing but `account_email`: with empty lists every
sender is `unknown` and every recipient but the mailbox itself is external,
so every such draft is refused and every such send is external — the safest reading. A mission must hold exactly one Gmail resource; two or more is
denied as ambiguous (no tool argument selects a mailbox).

## Tools

| Tool                                                                                             | Slices → risk(s)                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gmail__describe_zones` (synthetic), `gmail__list_labels`                                        | `label[*].R` → `read-mailbox`                                                                                                                                                                                                                    |
| `gmail__search_threads`                                                                          | `read-mailbox` + one `read-from-zone-*` per `from:` zone; `read-from-zone-unknown` + `bulk-read` when the query is not bounded; `read-sensitive-label` for each sensitive label the query does not exclude                                       |
| `gmail__get_thread`, `gmail__get_attachment`                                                     | `read-mailbox` + `read-from-zone-unknown` (+ `read-sensitive-label` when the mailbox declares sensitive labels) — worst case: sender and labels are unknown before the fetch                                                                     |
| `gmail__list_drafts`                                                                             | `read-drafts`                                                                                                                                                                                                                                    |
| `gmail__create_draft`                                                                            | `draft-write` + `draft-to-zone-{self,internal,allowlist}` (worst recipient wins); **refused** when a recipient is external or does not parse                                                                                                     |
| `gmail__send_message`, `gmail__send_draft`                                                       | one of `send-to-zone-{self,internal,allowlist,external}` (worst recipient, Bcc included); **refused** with no recipient, more than 100, or one that does not parse; `send_draft` also needs its `id` and is priced on the recipients it declares |
| `gmail__label_message`, `gmail__unlabel_message`, `gmail__label_thread`, `gmail__unlabel_thread` | `label-write` (+ the fallback `uncategorized-write` when the label is, or may be, a sensitive one); **refused** for `TRASH` / `SPAM` or a missing id                                                                                             |
| `gmail__create_label`                                                                            | `label-create` (+ the fallback when the name is, or is under, a sensitive label); **refused** for a system label id, `TRASH` / `SPAM` or a name under `[Gmail]/`                                                                                 |

The classifier fails closed — what it cannot read costs the worst case or
refuses the call:

- **Searches.** A query is _bounded_ only when it is a plain conjunction
  holding at least one positive `from:<full address>`. An `OR`, a grouping
  (`( ) { } |`), a quoted phrase, a `from:` that is not one address
  (`from:support`), or no `from:` at all (`to:` only, `label:` only,
  `-from:`) is `read-from-zone-unknown` + `bulk-read`. A negation or an
  operator the parser does not model adds `read-from-zone-unknown`.
- **Automated senders.** A sender is `automated` when it is on an internal
  or allowlisted domain (or is an allowlisted address) **and** the local
  part of its full address _is_ a no-reply name (`no-reply@`,
  `notifications@`…). On a domain nobody listed the local part is chosen by
  the sender and decides nothing: `noreply@unlisted.example` is `unknown`.
  `supportive.ceo@myorg.com` is `internal`.
- **Sensitive labels.** On a mailbox that declares some, `get_thread` always
  carries the marker and a search carries it for each label it does not
  exclude with `-label:<name>` in a plain conjunction.
- **Recipients.** One address per string, `addr@example.com` or
  `Name <addr@example.com>`; anything else (two addresses in one string, an
  object, a bare word) refuses the call. A recipient outside the internal
  domains and the allowlists refuses the draft; it makes a send
  `send-to-zone-external`.
- **Label writes.** `thread_id`, `message_id` (message tools) and `label` are
  required and validated. A user label is addressed by its name, as
  `list_labels` returns it; on a mailbox with sensitive labels, only system
  label ids (`INBOX`, `STARRED`, `UNREAD`, `IMPORTANT`…) and names that are
  not, and are not under, a sensitive label are plain `label-write`.
- **Identifiers.** A thread or message id is the lower-case hexadecimal of
  Gmail's 64-bit `X-GM-THRID` / `X-GM-MSGID`, the Gmail API's spelling
  (`gmailId`: `[0-9a-f]`, 1 to 16 characters); an attachment's `part` a
  MIME part number (`gmailPartId`: `2`, `1.2`); a label is a system id or a
  name in any script with spaces and common punctuation (`labelRef`:
  `Clients 2026`, `Factures payées`, `Projets/Été`; at most 225 characters,
  `/` for nesting, no empty, `.` or `..` segment, no blank at either end, no
  control character, quote, backslash, `*` `%`, brace or bracket;
  `writableLabel` also refuses `TRASH` and `SPAM`, `creatableLabel` a system
  id and `[Gmail]/`). Anything else is refused, never escaped. `execute` takes its ids
  and labels from these functions and from nothing else.

Any other tool name is `denied`.

The declarations live in `gmailClassifiedToolDeclarations`, which
`gmailTools` exposes (argument names `q`, `max_results`, `id`, `thread_id`,
`message_id`, `part`, `label`, `name`, `to`/`cc`/`bcc`, `subject`, `body`).

## Execution over IMAP and SMTP

One IMAP session per call, and one SMTP connection per send, with a
60-second deadline and the call's abort signal; every argument is checked
first, so a refused call opens no connection. Folders are found by their SPECIAL-USE (`\All`, `\Drafts`),
never by name: Gmail localizes them.

| Tool                    | IMAP                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_threads`        | `X-GM-RAW <q>` in All Mail, newest first, grouped by thread; `max_results` 10 by default, 50 at most                                                                                                                                              |
| `get_thread`            | the thread's messages (`X-GM-THRID`), newest 50: headers, labels, attachments (part, file name, MIME type, size) and a body of 20 000 characters: the text/plain part, else the text/html part (200 000 bytes read) converted to text, links kept |
| `get_attachment`        | one listed attachment, base64; refused above 5 MiB decoded                                                                                                                                                                                        |
| `list_drafts`           | the Drafts folder, newest 50                                                                                                                                                                                                                      |
| `create_draft`          | a plain-text RFC 5322 message appended to Drafts with `\Draft`; never sent                                                                                                                                                                        |
| `send_message`          | SMTP only: the same plain-text message without a `Bcc` header, the recipients in the envelope; Gmail files the copy in Sent                                                                                                                       |
| `send_draft`            | the draft's envelope must hold exactly the declared To, Cc and Bcc; its source (7 MiB at most) is relayed without its `Bcc` header, then the draft is removed from Drafts                                                                         |
| `list_labels`           | `INBOX`, `STARRED`, `IMPORTANT`, `UNREAD`, then the user labels (folders without a special use)                                                                                                                                                   |
| `label_*` / `unlabel_*` | `STORE ±X-GM-LABELS` (`UNREAD`: `∓\Seen`); a label that does not exist is never created                                                                                                                                                           |
| `create_label`          | `CREATE`; refused when the name exists (any case) or is a system folder                                                                                                                                                                           |
| `describe_zones`        | synthetic: the resource's zoning metadata, no connection                                                                                                                                                                                          |

`SENT`, `DRAFT`, `CHAT` and the `CATEGORY_*` tabs cannot be written over IMAP
and are refused. The subject of a draft holds no line break or control
character (refused), its recipients are the addresses the classifier parsed,
and its body is base64: nothing the agent writes can add a header.
The transport is an interface (`GmailTransport`, `src/transport.ts`):
`createGmailPlugin({ transport })` runs the plugin over a fake one.

## Catalog and macro-actions

`src/risk-catalog.yaml` — twenty risks plus the mandatory
`gmail.uncategorized-write` fallback (5 added
`gmail.label-create`; 6 drops "Experimental" from a description; 7 adds the
macro-actions; 8 the four `gmail.send-to-zone-*`, in the `send` macro-action
"Send", and drops the presets). No risk is
env-scoped (Gmail has no environment). No entry declares `caps` or
`infra_limits`: the door enforces no stateless cap (ADR
`scope-caps-amplification-axis`), so `gmail.read-from-zone-unknown` and
`gmail.bulk-read` are bounded by the mission's quota and rate limit only. The
SDK coverage kit showed the v4 catalog left two slices uncovered or on the
fallback: `draft-write` is the one id v5 adds, for the containment slice of
a draft (the zone risk carries the exfiltration axis), and `read-mailbox`,
an existing id, also matches the thread containment slice of `get_thread`.
The plugin is no longer experimental (see docs/handbook/plugin-sdk.md),
and sends over SMTP.

| Macro-action | What it covers                                                       | Risks                                                                                  |
| ------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `search`     | Read the structure, the threads and the messages, whoever sent them. | `read-mailbox`, `read-from-zone-*`, `read-drafts`, `read-sensitive-label`, `bulk-read` |
| `draft`      | Write and edit drafts. Nothing leaves.                               | `draft-write`, `draft-to-zone-self`, `-internal`, `-allowlist`                         |
| `tidy`       | Apply, remove and create labels.                                     | `label-write`, `label-create`, `bulk-label-write`                                      |

A creator ticks macro-actions at a trust level (Prudent / Confiant / Autonome,
risk model §4.6); the trust level sets each risk's gate from its vector and
multiplies the base budget. The mission stores the explicit list. At Prudent the sensitive
and bulk reads and bulk labels ask first. In no macro-action:
`gmail.draft-to-zone-external-unbounded` (the exfiltration vector — never
acceptable: the classifier refuses the draft, and the entry is kept
`deprecated` because ids are never deleted) and the fallback. Sending
(the four `gmail.send-to-zone-*`) is its own macro-action, "Send": a sent
message cannot be called back, so it is ticked on purpose; self is tier 1,
internal 3, allowlist and external 4.

## Credential — an app password

A person connects the mailbox alone, on its connect page:

1. In the Google Account of the mailbox, turn on 2-Step Verification
   (Security); Google offers app passwords only then.
2. Open <https://myaccount.google.com/apppasswords>, create an app password
   named "Vaubaan Gateway", copy the 16 letters.
3. Paste the address and the app password (spaces or not).

The gateway signs in over IMAP before storing anything (`verify`). An app
password has no scopes: it opens the whole mailbox over IMAP and sends over
SMTP, and what an agent may do is decided by its mission. It does not expire. A Google
Workspace administrator can turn app passwords off; IMAP must be on in
Gmail's settings. To withdraw access, delete the app password at the same
page: the gateway cannot do it.

A Gmail account connected by OAuth in an earlier build runs nothing until
its owner reconnects it with an app password.

## Development

```
npx vitest run plugins/gmail       # 609 tests, no network
npx tsc -p plugins/gmail/tsconfig.json --noEmit
```
