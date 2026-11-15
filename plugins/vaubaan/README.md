# `@vaubaan/plugin-vaubaan`

The gateway's own management tools, as a service: an agent prepares missions
for other agents, in a person's name, with a mission key on the execution door
(`/mcp`). A person connects their **Vaubaan account** in one click — it holds
no secret, belongs to them alone and is never shared — issues a mission on it
(the account page offers the platform management mission, every macro-action
at Careful) and hands its key to the agent.

The plugin is bundled with the gateway only: its `execute` is bound by the
host to the mission service (`apps/gateway/src/server/compose/vaubaan.ts`), and
a pin declaring a `host` account is refused at boot
([ADR](../../docs/decisions/platform-management-is-a-plugin-on-the-execution-door.md)).

Handbook (the model, the self rule, the refusals and the reasons behind them):
[`docs/handbook/services/vaubaan.md`](../../docs/handbook/services/vaubaan.md).

## Tools

The seven tools of the retired management door, same arguments and answers,
prefixed `vaubaan__`:

| Tool                            | Risk                         | Macro-action     |
| ------------------------------- | ---------------------------- | ---------------- |
| `vaubaan__list_my_accounts`     | `vaubaan.read-setup`         | Read my setup    |
| `vaubaan__get_catalog`          | `vaubaan.read-setup`         | Read my setup    |
| `vaubaan__preview_policy`       | `vaubaan.read-setup`         | Read my setup    |
| `vaubaan__list_my_missions`     | `vaubaan.read-missions`      | Read my setup    |
| `vaubaan__issue_mission`        | `vaubaan.mission-issue`      | Prepare missions |
| `vaubaan__rotate_mission_token` | `vaubaan.mission-key-rotate` | Rotate a key     |
| `vaubaan__revoke_mission`       | `vaubaan.mission-revoke`     | Stop missions    |

`vaubaan__request_permission` is the gateway's own tool, not this plugin's.

## Data model

```
accounts   account[<id>]           an account the person may build a mission from
catalogs   catalog[<service>]     the risk catalog of a service
missions   mission[<id>]           a mission of the person
             ├─ issue              verb leaf: a new mission issued
             ├─ token              verb leaf: its key replaced
             └─ revoke             verb leaf: stopped for good
```

No environment; the account carries no resource.

## Credential

Kind `host`: no field, nothing to paste or verify. Only the gateway creates
such an account, one per person.

## Tool schemas

`src/tool-schemas.json` is generated from the host's zod schemas: run
`npm run vaubaan:schemas` in `apps/gateway` after changing an argument.
