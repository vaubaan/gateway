---
title: Provider plugin handbooks — index
tracks:
  - plugins/*/src/risk-catalog.yaml
  - plugins/*/src/index.ts
  - apps/gateway/src/server/connections/shipped-providers.test.ts
last_reviewed: 2026-10-27
---

# Provider plugin handbooks

One handbook per plugin (`plugins/<id>`): where to start, the classification invariants a reviewer
checks, upstream traps, what to set up at the provider, debug. Tools, slices, risks and presets are
read in `src/tools.ts`, `src/classify.ts` and `src/risk-catalog.yaml`. Model: spec
[`gateway-risk-model.md`](../../spec/gateway-risk-model.md) and
[`vaubaan-gateway.md`](../../spec/vaubaan-gateway.md) §5; contract:
[plugin-sdk](../plugin-sdk.md); new plugin: [`plugins/README.md`](../../../plugins/README.md).

## Rules every plugin follows (not repeated per handbook)

- The catalog is loaded with `catalogPathNextTo`; exactly one `<id>.uncategorized-write` fallback,
  `fallback: true`, in no preset; a risk id is deprecated (`replaced_by`), never deleted.
- A preset is a starting point; the persisted policy is always the explicit list of risk ids.
- **What is executed is what was classified**: one reader per plugin, shared by `classify` and
  `execute`; an identifier outside its grammar is refused, never escaped; one the slice grammar
  cannot carry is classified `[*]`
  ([ADR](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)).
- Undeclared arguments are refused in `classify` and again in `execute` when the executor forwards
  its arguments; a plugin that builds each request field by field ignores them.
- What the executor declines is an `isError` result carrying the reason (no `upstream_error` in the
  audit); a provider failure is thrown: 401/403 `UpstreamAuthError`, other statuses
  `UpstreamHttpError`.
- An env-scoped risk runs only on a resource labelled with an environment its entry lists: an
  **unlabelled resource cannot run env-scoped operations** (`risk-not-accepted`) until the owner
  labels it.
- A catalog, classifier or preset change updates the handbook in the same pull request and bumps
  `catalog_version` and the plugin `version` (`plugins/README.md`, "Step 11"). A stricter
  classification, or an executor refusing what it forwarded, is breaking (major; minor before 1.0).

## Index

| Plugin          | Handbook                                     | Credential | In one line                                                      |
| --------------- | -------------------------------------------- | ---------- | ---------------------------------------------------------------- |
| CalDAV Calendar | [`caldav.md`](./caldav.md)                   | `api-key`  | App password over Basic auth to any CalDAV server; not Google.   |
| Cloudflare DNS  | [`cloudflare-dns.md`](./cloudflare-dns.md)   | `api-key`  | Zone-scoped token; critical-record overlay.                      |
| Context7        | [`context7.md`](./context7.md)               | `api-key`  | Rewrap of mcp.context7.com; one resource per key.                |
| Fly.io          | [`fly.md`](./fly.md)                         | `api-key`  | Organization token; image guard, fresh snapshot, secrets masked. |
| GitHub          | [`github.md`](./github.md)                   | `api-key`  | Fine-grained token; also the agents' git remote.                 |
| Gmail           | [`gmail.md`](./gmail.md)                     | `api-key`  | App password over IMAP; never sends.                             |
| Google Calendar | [`google-calendar.md`](./google-calendar.md) | `oauth2`   | Rewrap of Google's Calendar MCP; OAuth client held by a broker.  |
| Miro            | [`miro.md`](./miro.md)                       | `oauth2`   | Rewrap of Miro's MCP; OAuth client registered by the gateway.    |
| Notion          | [`notion.md`](./notion.md)                   | `api-key`  | One resource per shared root page or database.                   |
| Railway         | [`railway.md`](./railway.md)                 | `api-key`  | Workspace or account token; services bound to their project.     |
| Resend          | [`resend.md`](./resend.md)                   | `api-key`  | Recipient zones from the domain resource.                        |
| SSH             | [`ssh.md`](./ssh.md)                         | `ssh-key`  | Pinned host key; command classes.                                |
| Stripe          | [`stripe.md`](./stripe.md)                   | `api-key`  | One resource per mode (test / live).                             |
| Supabase        | [`supabase.md`](./supabase.md)               | `api-key`  | Management API; `execute_sql` read-only.                         |
| Upstash Redis   | [`upstash-redis.md`](./upstash-redis.md)     | `api-key`  | Env from the owner's database label.                             |
| Vercel          | [`vercel.md`](./vercel.md)                   | `api-key`  | Declares `envOf` (the `env[<label>]` segment).                   |

## Revoking a connection: what happens at the provider

Revoking erases the credential and, where the provider documents an endpoint, withdraws the grant
there too ([connections](../connections.md),
[ADR](../../decisions/provider-side-revocation-on-connection-revoke.md)). An endpoint enters this table only once read in the
provider's documentation through Context7, never from memory.

| Provider        | Withdrawn by the gateway                                                               | Otherwise, by hand                                                               |
| --------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Google Calendar | **yes** — `POST /revoke` with the refresh token, relayed by the OAuth broker to Google | Google Account, Security, third-party apps with account access                   |
| Miro            | no                                                                                     | Miro profile settings, apps allowed: remove "Vaubaan Gateway"                    |
| SSH             | no                                                                                     | remove the connection's public key from `authorized_keys` on the host            |
| every other     | no, on purpose: a pasted key or app password                                           | delete it at the provider; the gateway erases its copy and deletes nothing there |

- Keys are not withdrawn on purpose: a person created them and may use them elsewhere. GitHub's
  `POST /credentials/revoke` is a leak-report endpoint (403 on an authenticated call); no endpoint
  deleting a Supabase or Railway personal token exists.
- Each plugin's "by hand" sentence is its `manualRevocation`, shown in the disconnect dialog.
  `shipped-providers.test.ts` pins which plugins declare an endpoint: adding one changes the test
  and this table in the same commit.
