# `@vaubaan/plugin-context7`

Context7 for Vaubaan Gateway: agents look up current library documentation
through the gateway, under a mission. The Context7 API key is a gateway
connection, kept encrypted by the gateway; it is never in an environment
variable or in an MCP client's configuration.

The plugin **rewraps the official Context7 MCP server**
(`https://mcp.context7.com/mcp`): its two tools, their descriptions and
their answers are Context7's own. The REST API
(`GET https://context7.com/api/v2/usage`) is used around them only, to check
a pasted key, for discovery and to explain a failed call. The shape is
Railway's ([ADR](../../docs/decisions/rewrap-official-mcps.md)).

Handbook (the model and the reasons behind it):
[`docs/handbook/providers/context7.md`](../../docs/handbook/providers/context7.md).

## Data model

One plane, `docs`:

```
index[docs]            the resource: the library index one Context7 key can query
  └─ library[<id>]     a Context7 library (/vercel/next.js, /org/project/version)
```

Context7 has no environment: no entity is `envScopable`, no risk is
env-scoped, and a label the owner puts on the resource changes nothing.

## Credential and resources

Kind `api-key`, one required secret field:

| Field     | Pattern                          | Purpose                                                              |
| --------- | -------------------------------- | -------------------------------------------------------------------- |
| `api_key` | `^ctx7sk-[A-Za-z0-9_-]{16,128}$` | A Context7 API key, created in the dashboard (API Keys). Shown once. |

A key reaches what its teamspace's policies allow and carries no permission
choice; usage is counted on the member who created it. It is sent as
`Authorization: Bearer <key>`, to the MCP server and to the REST API alike.

`verify` and `discoverResources` call `GET /v2/usage`, which Context7 does
not count as a request. A refused key (401) is reported at once and nothing
is stored. Discovery returns **one resource**: `ref` `docs`, "Context7
library index", with the teamspace's `plan` (`free`, `pro`, `enterprise`,
`payg`) in its metadata. The endpoint is not paginated. The ref is a constant
because no answer of Context7 identifies the teamspace; each connection has
its own resource.

Revoking: in the Context7 dashboard, API Keys. Revocation is immediate and
permanent. Context7 documents no revocation endpoint, so the gateway erases
its copy and revokes nothing.

**Recommended at Context7**: in the teamspace's library filter, keep to
verified libraries or a minimum trust score (answers are third-party text),
and on a paid plan set a spending limit (a mission's quota bounds the
mission, not the key).

## Tools

Two tools, the upstream names after the `context7__` prefix. They take no
resource argument: the mission's single Context7 resource is the target.

| Tool                           | Arguments                                   | Slice                                  |
| ------------------------------ | ------------------------------------------- | -------------------------------------- |
| `context7__resolve-library-id` | `query`, `libraryName` (both required)      | `context7.index[docs].library[*].R`    |
| `context7__query-docs`         | `libraryId`, `query` (required); `language` | `context7.index[docs].library[<id>].R` |

- `libraryId` is a leading `/` and 1 to 4 segments of `[A-Za-z0-9_.~@+-]`,
  no dot-only segment, at most 500 characters; anything else is refused.
  An id the slice grammar cannot carry (`/vercel/next.js@v14.3.0`) is
  classified as `library[*]` and sent unchanged.
- `query`, `libraryName` and `language` are free text of 1 to 500
  characters, sent as written and not inspected.
- **An argument the schema does not declare is refused**, in `classify` and
  in `execute`, with nothing sent. The upstream server reads aliases
  (`libraryName` for `libraryId`, `userQuery` for `query`…) that would carry
  the library a call reads past the classifier.

The declarations are frozen in `src/upstream-tools.json`, the `tools` array
of `tools/list` captured on 2026-10-16; a tool Context7 adds later is refused
until it is modelled. Refresh: POST `tools/list` to the MCP server (no key
needed), write the array, re-read the classifier, bump the version.

## Catalog

`src/risk-catalog.yaml`, version 1: one named risk and the fallback.

| Risk                           | Action | Notes                                                                                                         |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| `context7.query-docs`          | R      | Both tools. The agent's question leaves for Context7, which stores queries; each call spends the key's quota. |
| `context7.uncategorized-write` | W      | Fallback (`fallback: true`); no tool of the plugin writes, in no macro-action.                                |

## Macro-actions

| Macro-action | What it covers                            | Risks                                            |
| ------------ | ----------------------------------------- | ------------------------------------------------ |
| `ask`        | Ask Context7 about library documentation. | `query-docs` (base: 300 per period, 20 a minute) |

A creator ticks macro-actions at a trust level (Prudent / Confiant / Autonome,
risk model §4.6); the trust level sets each risk's gate from its vector and
multiplies the base budget. The mission stores the explicit list. The question cannot be
recalled once sent, so `query-docs` is irreversible: left out at Prudent, it
asks first at Confiant and Autonome.

## Failures

The MCP server answers a failed Context7 request with a tool result
`isError: true` on an HTTP 200 (a bad key included). The plugin does not
pass it through and does not read its text to decide: it asks
`GET /v2/usage` (free) about the key and throws

- `UpstreamAuthError` when the key is refused there (401 or 403; only a 401
  makes the gateway mark the account as needing reconnection);
- `UpstreamHttpError` 429 when the usage endpoint answers 429, or answers 200
  with a quota provably spent: a Free plan whose member reached the requests
  the plan includes, or a spending limit reached. A paid plan past its
  included requests is billed overage, not blocked, so it is not a 429;
- otherwise an `Error` carrying Context7's text, which the agent reads.

A failed HTTP status of the MCP server is thrown with its status. An aborted
call is rethrown as the abort.

## Tests

`npx vitest run plugins/context7` — 59 tests: the SDK kit
(`assertPluginWellFormed`, `assertNoWildcard`,
`assertCatalogCoverage`, `assertIdentifiersRefused` with no identifier in a
URL), the frozen upstream surface, the classifier branch by branch (every
alias refused, malformed library ids, free-text bounds, the resource),
`execute`, `discoverResources` and `verify` against `mockFetch` (the
JSON-RPC body, the headers, each failure, the probe's answers and the quota
rule, the abort signal). No test
calls Context7. `risk-catalog.test.ts` and `data-model.test.ts` lint the YAML
(slice → risk resolution included) and the model.
