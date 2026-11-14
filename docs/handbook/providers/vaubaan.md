---
title: Vaubaan provider plugin (the gateway's own management tools)
tracks:
  - plugins/vaubaan/src/
  - apps/gateway/src/server/vaubaan/
  - apps/gateway/src/server/compose/vaubaan.ts
  - apps/gateway/src/server/execution/upstream-stage.ts
  - apps/gateway/src/server/execution/retired-door.ts
  - apps/gateway/src/app/mcp/manage/route.ts
last_reviewed: 2026-11-14
---

# Vaubaan provider plugin — handbook

`@vaubaan/plugin-vaubaan`: how an agent prepares missions for other agents. A person connects their
**Vaubaan account** (one click, a `host` account: no secret, theirs alone, never shared), issues a
mission on it — the account page offers the **platform management mission**, every macro-action at
Careful — and the agent calls the `vaubaan__*` tools on `/mcp` with that mission's key. Spec:
[vaubaan-gateway](../../spec/vaubaan-gateway.md) §4.1 bis, §6, §8. ADR:
[platform-management-is-a-plugin-on-the-execution-door](../../decisions/platform-management-is-a-plugin-on-the-execution-door.md).
Rules common to every plugin: [providers README](README.md).

The seven tools keep the names, arguments and answers of the retired management door
(`list_my_accounts`, `get_catalog`, `list_my_missions`, `preview_policy`, `issue_mission`,
`rotate_mission_token`, `revoke_mission`), prefixed `vaubaan__`, so an agent instruction written for
the door still names the right tool. One answer changed: `issued_via` names the issuing mission
(`mission_id`, `mission_name`, `this_mission`) where it named the OAuth client.

## Start here

- [`plugins/vaubaan/src/ports.ts`](../../../plugins/vaubaan/src/ports.ts) — what the plugin is
  given: seven acts, each `(caller, args) → answer`; `VaubaanCaller` is the calling mission, its
  creator and the key's holder.
- [`plugins/vaubaan/src/execute.ts`](../../../plugins/vaubaan/src/execute.ts) — the declared
  `execute` refuses every call; `createVaubaanExecute(ports)` is the one the host runs.
- [`apps/gateway/src/server/compose/vaubaan.ts`](../../../apps/gateway/src/server/compose/vaubaan.ts)
  — the ports built as frozen objects of closures over seven mission-service methods and the
  catalogs; `hostExecutes` handed to the execution door.
- [`apps/gateway/src/server/vaubaan/acts.ts`](../../../apps/gateway/src/server/vaubaan/acts.ts) —
  the acts and the self rule; `inputs.ts` the zod schemas; `views.ts` the snake_case answers.
- [`execution/upstream-stage.ts`](../../../apps/gateway/src/server/execution/upstream-stage.ts)
  `forward` — runs a host-composed `execute` in place of the plugin's, the caller added.

## Invariants

- **The plugin knows neither the mission nor the budget.** The door decides the call like any
  other (key, accepted risks, budget, gates, audit) before an act runs; the act then works in the
  name of the mission's **creator**, within their current authority. The SDK contract is untouched
  but for the `host` credential kind; the caller exists only in the host's context type.
- **The hard deny is the dependency list**: the host module holds two ports (seven mission-service
  methods — not `setGate`, `edit`, `duplicate`, `verifyToken` — and the catalogs as data) and a
  logger. `server/vaubaan/hard-deny.test.ts` (types, imports) and
  `tests/integration/vaubaan/hard-deny.test.ts` (object graph of the real root) hold it.
- **The self rule, at every call, whatever the stored selection says** (like `isSelfResource`):
  a draft naming a Vaubaan account, by id or by provider, is refused before any preview
  (`vaubaan-account-not-allowed`); the calling mission is never rotated nor revoked through its own
  key (`self-not-allowed`); a teammate's key is refused before the arguments are read
  (`teammate-key-not-allowed`) — the acts reach the creator's whole authority, wider than the
  mission a teammate was added to. A machine key (made by the creator) passes.
- `rotate_mission_token` reaches only the missions the calling mission issued
  (`missions.issued_by_mission_id`); `MissionService.rotate` checks it again
  (`not-issued-by-mission`). `revoke_mission` reaches every mission of the creator.
- The mission it issues names the calling one (`issued_by_mission_id`), and the admin entry of every
  act stores it in `audit.mission_id` (`via_mission_id`): the act is also in the calling mission's
  activity, beside the call entry.
- `tool-schemas.json` (what an agent reads in `tools/list`) is generated from the host's zod schemas
  by `npm run vaubaan:schemas` in `apps/gateway`; `acts.test.ts` fails until it matches.
- A `host` account carries no resource: missions on it use the "account without resources" path
  (`{ scope: 'all' }` of nothing); `discoverResources` answers `[]`.
- **A host account takes no owner act**: never shared, transferred or reassigned, nothing to
  reconnect (`ownerActRefusal` → `account-personal`); it is not marked `unowned` when its person
  is deactivated (the derived rule stops its missions) and is not listed among the ownerless
  accounts. Connecting again hands back the person's active account: one per person.
- The plugin is enabled and disabled like any plugin (`plugins.enabled`); a pin declaring a `host`
  account is refused at boot, and the bundle script skips the plugin (`vaubaan.bundleable: false`).
- The host's `vaubaan__request_permission` is answered by exact name before the registry;
  `checkHostToolNames` stops the boot on a plugin tool of the same name.

## The catalog, row by row

Five risks and the fallback, one per act a person tells apart; no environment (the gateway has
none). Rows are read from the five facts by the decision tree
([gateway-risk-model](../../spec/gateway-risk-model.md) §4):

| Risk                         | Facts that decide                               | Row | Why                                                                                     |
| ---------------------------- | ----------------------------------------------- | --- | --------------------------------------------------------------------------------------- |
| `vaubaan.read-setup`         | reversible, metadata, internal                  | 1   | names, ids and permissions; no key or account secret ever leaves                        |
| `vaubaan.read-missions`      | reversible, metadata, internal                  | 1   | a key is shown by its masked prefix only                                                |
| `vaubaan.mission-issue`      | reversible, **`data: secret`**                  | 2   | the answer carries a new mission key, which the agent can hand on; revoked in one click |
| `vaubaan.mission-key-rotate` | reversible, **`data: secret`**                  | 2   | the answer carries the new key and cuts off whoever held the old one                    |
| `vaubaan.mission-revoke`     | **`reversibility: costly`**, `visibility: team` | 3   | cannot be undone; the work resumes only on a new mission whose key a person hands over  |

Macro-actions: **Read my setup** (both reads; preview is a read of the authority), **Prepare
missions** (issue), **Rotate a key**, **Stop missions** (revoke). Rotate is apart from Prepare
because it cuts off an agent holding the old key. At Careful the reads run freely and every write
asks the person first; at Trusting issuing and rotating run freely and stopping still asks.
`tests/unit/plugin.test.ts` of the plugin pins these gates.

## Refusals of the tools

A "no" of an act is a tool error (`isError: true`, `structuredContent.error`), so the model can
correct itself; a "no" of the door (risk not accepted, budget, approval) is the door's structured
refusal, as for any service. `acts.test.ts` holds this table to `VAUBAAN_REFUSAL_CODES`, both ways:

| `error.code`                  | When                                                                                         | Extra fields                     |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------- |
| `invalid-arguments`           | the arguments do not match the tool's input schema                                           | `issues`                         |
| `draft-refused`               | `issue_mission` on a draft the preview does not accept                                       | `uncovered`, `issues`, `preview` |
| `vaubaan-account-not-allowed` | `issue_mission` on a draft that names a Vaubaan account                                      | `account_ids`                    |
| `self-not-allowed`            | `rotate_mission_token` or `revoke_mission` on the calling mission                            | `mission_id`                     |
| `teammate-key-not-allowed`    | any tool, called with a teammate's key rather than the creator's or a machine key            |                                  |
| `mission-not-found`           | no such mission of this user (another user's, or one they are only a member of for a change) | `mission_id`                     |
| `mission-inactive`            | `rotate_mission_token` on a revoked, expired or orphaned mission                             | `mission_id`, `state`, `orphan`  |
| `mission-not-issued-here`     | `rotate_mission_token` on a mission the calling mission did not issue                        | `mission_id`                     |
| `unknown-provider`            | `get_catalog` on a provider the instance does not ship                                       | `providers`                      |
| `unknown-account`             | `get_catalog` with a `account_id` the user holds nothing on                                  | `account_id`                     |
| `instance-limit-reached`      | `issue_mission` while the instance holds as many active missions as `limits.active_missions` | `count`, `ceiling`               |
| `internal-error`              | a port threw (logged `vaubaan tool failed`); the message never carries details               |                                  |

## Traps

- The answers of `issue_mission` and `rotate_mission_token` carry a key shown once: arguments and
  answers are never logged, and the audit stores neither (`vaubaan-plugin.test.ts` searches both).
- There is no output schema any more: the SDK's tool declaration has none, and the door does not
  validate `structuredContent`. The TypeScript answers of `acts.ts` are the contract.
- The mutation budget of the former door is gone: the calling mission's own quota and rate limit on
  each risk are the limit.
- `/mcp/manage` answers 404 with a JSON hint (`retired-door.ts`), needing no root; an MCP client
  configured for it says so to its person.

## Procedures

- A new tool: an act in `acts.ts`, its schema in `inputs.ts`, its port in `index.ts` and
  `VAUBAAN_PORT_NAMES`, its name in `identity.ts`, its description and title in `tools.ts`, its
  slice in `classify.ts` (a new verb leaf in `data-model.ts`), a risk or an entry in
  `risk-catalog.yaml` (bump `catalog_version`), then `npm run vaubaan:schemas`. A new need of the
  mission service changes `ports.ts` first, then `compose/vaubaan.ts`.

## Migration from the management door

- Migration `0035_platform_management_plugin.sql` copies the name of the client that issued each
  delegated mission into `missions.issued_via_client_name` (history, shown as "prepared by <app>"),
  clears `missions.delegation_id`, drops the OAuth tables and empties `delegations` (kept, empty: a
  foreign key of `missions` names it). Every mission and its key keep working.
- Audit entries written by the door keep `delegated_client_id`; their `oauth-client` and
  `delegation` objects have no label any more.
- The `oauth.*` keys and their `VAUBAAN_OAUTH_*` variables are accepted and ignored, one warning
  at boot.
- For the person: Accounts → Connect a service → Vaubaan → Connect, then "Create the platform
  management mission" on the account page; give its key to the agent in place of the OAuth consent.
