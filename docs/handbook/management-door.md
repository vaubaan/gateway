---
title: Management door — authorization server, delegated tokens, tools
tracks:
  - apps/gateway/src/server/oauth-as/
  - apps/gateway/src/server/management/
  - apps/gateway/src/server/compose/management.ts
  - apps/gateway/src/server/store/repositories/delegations.ts
  - apps/gateway/src/app/oauth/
  - apps/gateway/src/app/.well-known/
  - apps/gateway/src/app/mcp/manage/route.ts
last_reviewed: 2026-10-31
---

# Management door — handbook

How an agent acts on behalf of a user: the instance is an OAuth authorization server for one
resource, `/mcp/manage`, whose tools prepare missions. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §4.1 bis, §6. ADR:
[management-door-authorization-server](../decisions/management-door-authorization-server.md).

## Start here

- [`oauth-as/endpoints.ts`](../../apps/gateway/src/server/oauth-as/endpoints.ts) — URLs, the one
  scope (`mgmt`), discovery documents; the only file assuming one scope and one resource.
- [`oauth-as/token-service.ts`](../../apps/gateway/src/server/oauth-as/token-service.ts) — code
  exchange, rotation, replay, reuse window.
- [`management/tools.ts`](../../apps/gateway/src/server/management/tools.ts) and
  [`management/ports.ts`](../../apps/gateway/src/server/management/ports.ts) — the tools and the
  only services they are handed.

## Invariants

- Every URL is built on `public_url`, never the host the process sees. Only SHA-256 digests of
  secrets are stored; nothing logs one (`http-surface.test.ts` searches the log).
- **Every grant is one store transaction**: a write fault rolls everything back (code unspent,
  refresh token still the head) and answers `server_error`, never `invalid_grant`, which would
  tell the client to discard its tokens.
- A replay (outside the reuse window) revokes the delegation, names its running missions in
  `after.missions_to_review`, revokes none, and takes no rate budget. `endDelegation` is the one
  way a delegation ends, audited once (`revokeIfActive` answers only the revoking caller).
- Derived at every use, never stored: the registration policy (only an operator's decision is
  stored; a stricter config stops issued tokens at their next call) and the delegation's absolute
  lifetime (from `created_at`; nothing is written when it passes).
- **The hard deny is the dependency list**: the door holds no `MissionService` (it has `setGate`),
  no request, budget, connection, share, group or execution service (`hard-deny.test.ts`). The
  mission service, not the door, checks the delegating user's current authority.
- An agent composes a connection from `trust_levels` (macro-action → trust level) or `everything-i-hold`; the
  views say what each trust level yields with the mission module's own `expandMacroAction`
  (`at_trust_level`), and `get_catalog` gives each risk's tier and the trust level table, so the agent can
  predict the preview. Catalogs ship no presets: any other `preset` is `unknown-preset`.
- `rotate_mission_token` reaches only missions this delegation issued; `MissionService.rotate`
  checks it again (`not-issued-by-delegation`).

## Traps

- Nothing is sent to a redirect URI, not even an error, before a user is signed in and the client
  may ask: registration is anonymous, so an early error redirect would be an open redirect.
- The consent page uses `Referrer-Policy: same-origin`, not `no-referrer`: a `no-referrer` form
  posts `Origin: null`, which the mutation guard refuses.
- The MCP SDK validates `outputSchema` **after** the tool ran: a mismatch would lose a once-shown
  token after the write. So every output object is loose, and every success path is parsed in
  `tests/integration/management/output-schemas.test.ts`.
- Protocol endpoints never read the cookie. A client's rate budget is spent only by a caller that
  proved it holds something of it (a `client_id` is no secret).
- A `public_url` with a sub-path: the proxy must route
  `/.well-known/oauth-authorization-server/<path>` to the root document.

## Refusals of the tools

A "no" is a tool error (`isError: true`, `structuredContent.error`), so the model can correct
itself. `tools.test.ts` holds this table to `MANAGEMENT_REFUSAL_CODES`, both ways:

| `error.code`              | When                                                                                         | Extra fields                     |
| ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------- |
| `draft-refused`           | `issue_mission` on a draft the preview does not accept                                       | `uncovered`, `issues`, `preview` |
| `mission-not-found`       | no such mission of this user (another user's reads the same)                                 | `mission_id`                     |
| `mission-inactive`        | `rotate_mission_token` on a revoked, expired or orphaned mission                             | `mission_id`, `state`, `orphan`  |
| `mission-not-issued-here` | `rotate_mission_token` on a mission of the user that this delegation did not issue           | `mission_id`                     |
| `unknown-provider`        | `get_catalog` on a provider the instance does not ship                                       | `providers`                      |
| `unknown-connection`      | `get_catalog` with a `connection_id` the user holds nothing on                               | `connection_id`                  |
| `rate-limited`            | the delegation's mutation budget is spent                                                    | `retry_after_seconds`            |
| `instance-limit-reached`  | `issue_mission` while the instance holds as many active missions as `limits.active_missions` | `count`, `ceiling`               |
| `internal-error`          | the method threw (logged `management tool failed`); the message never carries details        |                                  |

## Procedures

- A new tool: a `ManagementTools` method, entries in `MANAGEMENT_TOOLS` and
  `MANAGEMENT_OUTPUT_SCHEMAS`, its success paths in the output-schemas test; a new need changes
  `ports.ts` first, then `compose/management.ts`.

## Debug

- **The client never opens the browser** → `curl -i -X POST <public_url>/mcp/manage` must answer
  401 with `resource_metadata`; a proxy stripping `WWW-Authenticate` breaks discovery.
- **401 at the door with an unexpired token** → the client is no longer approved (policy,
  disabled, a new non-loopback redirect URI), or the delegation reached its lifetime.
- **Delegation revoked "by the gateway"** → a refresh token presented twice outside the window:
  two processes sharing a token store, or a leak (`reuse_window: true` log lines point to the
  first). A re-authorized client is a new delegation and cannot rotate the old missions.
