---
title: Plugin identifiers — one grammar per kind, shared by `classify` and `execute`; refuse, never escape
status: accepted
date: 2026-10-13
extends:
  - plugin-contract-and-credential-spec
---

# Plugin identifiers — one grammar per kind, shared by `classify` and `execute`; refuse, never escape

> Decided in P3.4 after the defect P3.1 found in the plugin template, and the
> audit of the ten shipped plugins that followed. Handbooks:
> [plugin-sdk](../handbook/plugin-sdk.md), each provider's handbook under
> `docs/handbook/providers/`.

## Context

The gateway decides a call from the slices a plugin's `classify` returns, then
hands the same arguments to the plugin's `execute`. The whole model rests on
one sentence: **what is executed is what was classified**.

The plugin template interpolated an identifier into the upstream path after a
check that let `.`, `..` and `/` through. `widget_id: '..'` was classified as
a widget and sent to the parent endpoint: every URL parser removes dot
segments, and `encodeURIComponent` leaves `.` and `..` untouched. The shipped
plugins shared the pattern in several forms:

- a `SAFE_IDENT`-style class (`[a-zA-Z0-9_./~-]`) copied from the slice
  grammar, where "fits a slice" was taken for "safe in a path";
- validation in `classify` only, `execute` re-reading the raw argument (with
  another default, another field precedence, or `String(value)`);
- identifiers from a **resource ref**, **connection metadata** or a **provider
  answer** interpolated without any check;
- a string that the provider may read as several values (a recipient list in
  a display name).

Found and closed (the reproductions are in each plugin's test file):
`supabase__delete_object` with a path leaving its bucket, and
`delete_function '..'` reaching the project endpoint; Vercel
`remove_project_domain '..'`; GitHub `workflow_id '..'` listing every
workflow's runs, `branch '..'` on branch protection, and `execute` minting an
installation-wide token for `repo: ''`; Upstash `delete_database '..'`;
Resend ids and a provider-supplied contact id; Stripe ids validated in
`classify` only; Railway `execute` forwarding ids the classifier had not
bound to the mission's project.

## Decision

Every plugin, shipped or contributed, follows four rules.

1. **One grammar function per identifier kind**, named for the kind
   (`pathIdent`, `repoPath`, `branchName`, `bucketId`, `domainName`,
   `hostRef` …). It returns the validated value or `null`.
2. **`classify` and `execute` call the same function** — better, the same
   _reader_ that returns every identifier of the call (`readGithubCall`,
   `readIdentifiers`, `resolveDatabase`). `execute` builds its request from
   what the reader returned, never from `args`. It validates by itself: it
   must be safe when called alone.
3. **Refuse, never repair.** A value outside its grammar is a denial in
   `classify` and a refusal in `execute`. No trimming, no escaping, no
   substitution, no "read as absent".
4. **The grammar is chosen for where the value lands**, not for the slice:
   - a URL path segment: no `.`-only value, no separator, no `%`; the
     default is `[A-Za-z0-9_-]{1,64}`;
   - a value that is legitimately dotted or multi-segment (a domain, a file
     path, a git ref, a bucket name) gets a grammar of its own that forbids
     empty and dot-only segments, backslashes and control characters, and
     bounds the length;
   - a query: built with `URLSearchParams`; GraphQL: a variable, never the
     document text; SQL identifiers: a closed grammar, no quoting;
   - anything the provider could split (a recipient): one string is one
     value.
     The same holds for identifiers that come from a resource ref, connection
     metadata or a provider's answer.

Each plugin proves it with a test file that feeds `..`, `.`, `a/../b`,
`%2e%2e`, `%2f`, an empty value, an overlong value, a line break and
`?x=1#y` to **both** `classify` and `execute`, and asserts that a refused
value produces no upstream request and an accepted one names exactly the
classified resource.

## Consequences

- Values a provider would accept but the grammar does not are refused at the
  gateway: an object path with a space (Supabase), a Vercel domain with an
  underscore label, a branch name git itself would reject, a tag given as
  `refs/tags/…`. The refusal names the argument. Widening a grammar is a
  reviewed change with its tests.
- A resource whose discovered ref is outside the grammar is skipped at
  discovery (GitHub) or fails it (the template, Vercel, Railway, Supabase).
- `SAFE_IDENT` is gone from the plugins' public exports (Stripe, Resend,
  Cloudflare DNS). The slice grammar of the policy engine keeps its wider
  identifier class: it describes what a slice may name, not what a URL may
  carry.
- [`plugins/README.md`](../../plugins/README.md) (steps 4, 6 and 8) and the
  [plugin-sdk](../handbook/plugin-sdk.md) handbook state these rules for
  contributors.
- Not closed, and listed in the threat model: Railway `serviceId` and
  `get-logs deploymentId` are shape-checked, but discovery stores only a
  project's environments, so the plugin cannot verify that a service or a
  deployment belongs to the mission's project.

## Rejected alternatives

- **Escape instead of refuse** (`encodeURIComponent` everywhere). It is what
  most of the plugins did, and the defect: `.` and `..` survive it, and a
  value that needed escaping was classified in its unescaped form.
- **A single grammar in the plugin SDK.** Identifier shapes differ per
  provider (a GitHub repository name may be `.github`, a Stripe product id
  may be `com.example.pro`, a DNS name has labels). The SDK could only offer
  the narrowest one; each plugin states its own kinds next to the tools that
  use them.
- **Validate in the host**, between `classify` and `execute`. The host does
  not know which argument is an identifier nor where it lands; the plugin is
  the only place that does.
- **Trust the provider to reject odd paths.** Some do, some route a collapsed
  path to a broader endpoint; the gateway's decision must not depend on it.
