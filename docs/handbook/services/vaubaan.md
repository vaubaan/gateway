---
title: Vaubaan plugin (the gateway's own management tools)
tracks:
  - plugins/vaubaan/src/
  - apps/gateway/src/server/vaubaan/
  - apps/gateway/src/server/compose/vaubaan.ts
  - apps/gateway/src/server/execution/upstream-stage.ts
  - apps/gateway/src/server/execution/retired-door.ts
  - apps/gateway/src/app/mcp/manage/route.ts
last_reviewed: 2026-11-16
---

# Vaubaan plugin — handbook

`@vaubaan/plugin-vaubaan`: how an agent prepares missions for other agents. A person connects their
**Vaubaan account** (one click, a `host` account: no secret, theirs alone, never shared), issues a
mission on it — the account page offers the **platform management mission**, every macro-action at
Careful — and the agent calls the `vaubaan__*` tools on `/mcp` with that mission's key. Spec:
[vaubaan-gateway](../../spec/vaubaan-gateway.md) §4.1 bis, §6, §8. ADR:
[platform-management-is-a-plugin-on-the-execution-door](../../decisions/platform-management-is-a-plugin-on-the-execution-door.md).
Rules common to every plugin: [services README](README.md).

Seven tools keep the names, arguments and answers of the retired management door
(`list_my_accounts`, `get_catalog`, `list_my_missions`, `preview_policy`, `issue_mission`,
`rotate_mission_token`, `revoke_mission`), prefixed `vaubaan__`, so an agent instruction written for
the door still names the right tool. One answer changed: `issued_via` names the issuing mission
(`mission_id`, `mission_name`, `this_mission`) where it named the OAuth client. Two came later
(ADR amendment 2026-11-16): `rename_mission` and `edit_mission`, the creator's own "Edit mission";
`preview_policy` with `mission_id` previews an edit, and `list_my_missions` with `mission_id` answers
the mission as a `draft` to edit. Two more (plugin 0.5.0; ADR
[plugins-activated-by-an-administrator-on-trial](../../decisions/plugins-activated-by-an-administrator-on-trial.md)):
`upload_plugin` hands over an archive, which stays pending, and `plugin_status` reads the plugins
of the instance — both refused `administrator-only` unless the mission's creator is an
administrator. They reach the install service through a third port, `plugins`
(`compose/vaubaan.ts` `vaubaanPluginsOf`: four closures; nothing that activates, refuses, rolls back
or removes a plugin), and live in `server/vaubaan/plugin-acts.ts`.

## Start here

- [`plugins/vaubaan/src/ports.ts`](../../../plugins/vaubaan/src/ports.ts) — what the plugin is
  given: nine acts, each `(caller, args) → answer`; `VaubaanCaller` is the calling mission, its
  creator and the key's holder.
- [`plugins/vaubaan/src/execute.ts`](../../../plugins/vaubaan/src/execute.ts) — the declared
  `execute` refuses every call; `createVaubaanExecute(ports)` is the one the host runs.
- [`apps/gateway/src/server/compose/vaubaan.ts`](../../../apps/gateway/src/server/compose/vaubaan.ts)
  — the ports built as frozen objects of closures over ten mission-service methods and the
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
- **The hard deny is the dependency list**: the host module holds two ports (ten mission-service
  methods — `edit` with its reads `editView` and `previewEdit`, but not `setGate`, `setLimits`,
  `changePermissions`, `restore`, `duplicate`, `verifyToken` — and the catalogs as data) and a
  logger. `server/vaubaan/hard-deny.test.ts` (types, imports) and
  `tests/integration/vaubaan/hard-deny.test.ts` (object graph of the real root) hold it.
- **The self rule, at every call, whatever the stored selection says** (like `isSelfResource`):
  a draft naming a Vaubaan account, by id or by service, is refused before any preview
  (`vaubaan-account-not-allowed`), at issuance and at an edit; the calling mission is never renamed,
  edited, rotated nor revoked through its own key (`self-not-allowed`), nor is its edit previewed; a teammate's key is refused before the arguments are read
  (`teammate-key-not-allowed`) — the acts reach the creator's whole authority, wider than the
  mission a teammate was added to. A machine key (made by the creator) passes.
- `rotate_mission_token` reaches only the missions the calling mission issued
  (`missions.issued_by_mission_id`); `MissionService.rotate` checks it again
  (`not-issued-by-mission`). `revoke_mission`, `rename_mission` and `edit_mission` reach every
  mission of the creator (`editView` is `null` for a member).
- **A rename is an edit of the name alone**: the act reads `editView` (the draft and its revision)
  and sends `MissionService.edit` that draft with the new name. Rename and edit both pass
  `issuedBy`: the version they leave is authored `{ kind: 'mission' }` (History "by <mission>"),
  the `mission-changed` entry carries `via_mission_id`. The edit is applied from the revision read
  in the same call, so the agent sends no revision; a write racing it is
  `mission-changed-meanwhile`. An edit of the whole mission needs the stored set `id`s, which only
  the `draft` of `list_my_missions` gives: a set sent without its id is a new set, fresh counters.
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
- **One Vaubaan account per person is held by the store**, not by the connect alone: the partial
  unique index `accounts_one_host_per_person` (migration 0040) on `(service, owner_user_id)` of
  the accounts not revoked whose `metadata.credential_kind` is `host`. Whatever path writes one,
  a second is refused (`HostAccountTakenError`); `connectHost` reads that refusal as "already
  connected" and hands back the account that won, so two connects at once answer the same
  account and only one `account-created` entry is written. The scope is per person, never one
  per gateway; a revoked account frees the slot.
- The plugin is enabled and disabled like any plugin (`plugins.enabled`); a pin declaring a `host`
  account is refused at boot, and the bundle script skips the plugin (`vaubaan.bundleable: false`).
- The host's `vaubaan__request_permission` is answered by exact name before the registry;
  `checkHostToolNames` stops the boot on a plugin tool of the same name.

## The catalog, row by row

Seven risks and the fallback, one per act a person tells apart; no environment (the gateway has
none). Rows are read from the five facts by the decision tree
([gateway-risk-model](../../spec/gateway-risk-model.md) §4):

| Risk                         | Facts that decide                               | Row | Why                                                                                      |
| ---------------------------- | ----------------------------------------------- | --- | ---------------------------------------------------------------------------------------- |
| `vaubaan.read-setup`         | reversible, metadata, internal                  | 1   | names, ids and permissions; no key or account secret ever leaves                         |
| `vaubaan.read-missions`      | reversible, metadata, internal                  | 1   | a key is shown by its masked prefix only                                                 |
| `vaubaan.mission-issue`      | reversible, **`data: secret`**                  | 2   | the answer carries a new mission key, which the agent can hand on; revoked in one click  |
| `vaubaan.mission-rename`     | reversible, metadata, internal                  | 1   | a name only; nothing the agent may do moves                                              |
| `vaubaan.mission-edit`       | reversible, **`blast: account`**, team          | 2   | one edit may widen a mission to all the person holds; edited back or restored in one act |
| `vaubaan.mission-key-rotate` | reversible, **`data: secret`**                  | 2   | the answer carries the new key and cuts off whoever held the old one                     |
| `vaubaan.mission-revoke`     | **`reversibility: costly`**, `visibility: team` | 3   | cannot be undone; the work resumes only on a new mission whose key a person hands over   |

Macro-actions: **Read my setup** (both reads; preview is a read of the authority, of a mission
too with `mission_id`), **Prepare missions** (issue, rename, edit), **Rotate a key**, **Stop
missions** (revoke). Rotate is apart from Prepare because it cuts off an agent holding the old key.
At Careful the reads and a rename run freely and every other write asks the person first; at
Trusting issuing, editing and rotating run freely and stopping still asks.
`tests/unit/plugin.test.ts` of the plugin pins these gates.

## Refusals of the tools

A "no" of an act is a tool error (`isError: true`, `structuredContent.error`), so the model can
correct itself; a "no" of the door (risk not accepted, budget, approval) is the door's structured
refusal, as for any service. `acts.test.ts` holds this table to `VAUBAAN_REFUSAL_CODES`, both ways:

| `error.code`                  | When                                                                                                                                  | Extra fields                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `invalid-arguments`           | the arguments do not match the tool's input schema                                                                                    | `issues`                                                     |
| `draft-refused`               | `issue_mission` or `edit_mission` on a draft the preview does not accept                                                              | `uncovered`, `issues`, `preview` (issue) or `changes` (edit) |
| `vaubaan-account-not-allowed` | `issue_mission` or `edit_mission` on a draft that names a Vaubaan account                                                             | `account_ids`                                                |
| `self-not-allowed`            | any tool naming the calling mission but `list_my_missions`                                                                            | `mission_id`                                                 |
| `teammate-key-not-allowed`    | any tool, called with a teammate's key rather than the creator's or a machine key                                                     |                                                              |
| `mission-not-found`           | no such mission of this user (another user's, or one they are only a member of for a change)                                          | `mission_id`                                                 |
| `mission-inactive`            | rotate on a revoked, expired or orphaned mission; rename or edit on a revoked or orphaned one                                         | `mission_id`, `state`, `orphan`                              |
| `mission-not-issued-here`     | `rotate_mission_token` on a mission the calling mission did not issue                                                                 | `mission_id`                                                 |
| `mission-changed-meanwhile`   | `rename_mission` or `edit_mission` raced another write of the mission; nothing was changed                                            | `mission_id`                                                 |
| `unknown-service`             | `get_catalog` on a service the instance does not ship                                                                                 | `services`                                                   |
| `unknown-account`             | `get_catalog` with a `account_id` the user holds nothing on                                                                           | `account_id`                                                 |
| `instance-limit-reached`      | `issue_mission`, or a new end reviving an ended mission, at `limits.active_missions`                                                  | `count`, `ceiling`                                           |
| `administrator-only`          | `upload_plugin`, `plugin_status`: the mission's creator is not an administrator of the instance                                       | —                                                            |
| `plugin-refused`              | `upload_plugin`: the archive is not one this gateway reads, built for another SDK, unsigned and not allowed, or of an id of the image | `reason`: the upload's problem code                          |
| `internal-error`              | a port threw (logged `vaubaan tool failed`); the message never carries details                                                        |                                                              |

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

## Migration 0040: duplicates of an earlier build

An instance that stored two Vaubaan accounts for one person (two connects at once, before the
index) is resolved at the upgrade, before the index is created: per person, the oldest `active`
account is kept (else the oldest), and every other one is revoked as a disconnect revokes it.
Missions are **not moved** to the kept account: the revoked account's part of each is lost, as
after any disconnect (its card says so, calls through it are refused `account-revoked`), and a
platform management mission that held only that account serves nothing until its creator edits it
onto the kept account or issues a new one. Each revocation is one `account-revoked` audit entry by
the actor `migration` ("A gateway upgrade", `MIGRATION_ACTOR_ID`), whose `after` names
`kept_account_id` and the `mission_ids` that held the revoked account; the owner reads it in the
account's activity. To find them: Activity, actor "A gateway upgrade".

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
