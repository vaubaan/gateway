# `@vaubaan/plugin-upstash-redis`

Upstash Redis provider plugin for Vaubaan Gateway: databases through the
Upstash Management API, key-value data through each database's REST
endpoint. Written against [`@vaubaan/plugin-sdk`](../../packages/plugin-sdk)
only.

- Contract: ADR [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md),
  handbook [`plugin-sdk`](../../docs/handbook/plugin-sdk.md).
- Modelling: handbook [`providers/upstash-redis`](../../docs/handbook/providers/upstash-redis.md)
  (data model, tool → slice mapping, catalog, edge cases).

## Layout

| File                    | Role                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`          | `definePlugin({...})` — default export `upstashRedisPlugin`.                                                                                               |
| `src/identity.ts`       | The provider id and the 21 tool names (`TOOL`), written once.                                                                                              |
| `src/risk-catalog.yaml` | 10 risks + fallback, four macro-actions. Loaded at boot by the SDK; the only catalog artefact.                                                             |
| `src/data-model.ts`     | One plane `cache`, 6 entities; `database` is the env-scopable entity (the resource).                                                                       |
| `src/tools.ts`          | 21 custom tools: 6 management (Management API) + 15 data (per-database REST).                                                                              |
| `src/classify.ts`       | `(tool, args, resources) → slices`. Pure. Database resolution against the mission's resources; the command table of `execute`.                             |
| `src/credential.ts`     | `api-key` spec: account email + Management API key; `upstashAuth()` narrows the secret.                                                                    |
| `src/execute.ts`        | Management API (Basic auth) and Data API (per-database Bearer, on a REST endpoint pinned to `https://<label>.upstash.io`), redaction, `discoverResources`. |

`src/index.ts` resolves the YAML path with the SDK helper
`catalogPathNextTo(import.meta.url)`, not with
`new URL('./risk-catalog.yaml', import.meta.url)`: the bundler rewrites that
pattern into an asset URL that Node's `fileURLToPath` rejects (see
docs/handbook/plugin-sdk.md).

## Data model

```
account ─ database[<id>] ─┬─ key-space[<key>] ─┬─ delete     (DEL, UNLINK, HDEL, LPOP, EXPIRE, RENAME… marker)
                          │                    ├─ flush      (FLUSHDB / FLUSHALL marker)
                          │                    └─ execute    (script, administration, unknown command marker)
                          ├─ credentials                     (rename, tokens, passwords)
                          ├─ stats
                          └─ backup                          (declared, no tool yet)
```

The **database** (Upstash database id) is the resource a connection exposes
and a mission selects. The **environment** is the owner's label on that
resource (`development`, `staging`, `prod`): every slice carries
`database[<id>]`, which the host's default `resourceEnvResolver` maps to the
label. No plugin-side env hook is needed. Every write risk is env-scoped, so
a write on a database with no label, or with a label outside those three, is
refused whatever the mission accepts; reads still pass.

## The generic `execute` tool

`execute` is authorized on the command it carries, not on the tool: every
Redis command belongs to exactly one class of the table in `src/classify.ts`
(`KNOWN_READS`, `KNOWN_WRITES`, `KNOWN_DELETES`, `KNOWN_DESTRUCTIVE`,
`KNOWN_ARBITRARY`, `KNOWN_ADMIN`), and the same command costs the same risk
through a dedicated tool and through `execute`.

| Command                                                                                           | Risks needed (in the database's environment) |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| read (`GET`, `SCAN`, `HGETALL`…)                                                                  | `read-data`                                  |
| write a value that stays (`SET`, `INCR`, `HSET`, `LPUSH`…)                                        | `write-data`                                 |
| delete, now or later (`DEL`, `UNLINK`, `HDEL`, `LPOP`, `EXPIRE k 60`, `SET k v EX 60`, `RENAME`…) | `write-data` + `delete-data`                 |
| `FLUSHDB` / `FLUSHALL`                                                                            | `write-data` + `flush-database`              |
| script, administration, unknown or unreadable command                                             | `write-data` + `execute-arbitrary`           |
| a pipeline or MULTI / EXEC body                                                                   | the union over its commands                  |

`write-data` alone cannot run a deletion command, a FLUSH or an arbitrary
command — nor make a key go away another way: any time to live (`EXPIRE`,
`SETEX`, `SET … EX`) and the moves (`RENAME`, `LMOVE`, `SMOVE`) are
deletions, and need `delete-data` too. A cache write with a TTL therefore
needs both risks.

A command the classifier cannot read is never cheaper than the catch-all.
The executor sends exactly what was classified (`redisCommandOf`) and
refuses a pipeline-shaped `command`: no pipeline endpoint is wired. To add a
verb, put it in exactly one set (a verb listed twice fails the import) and
add a row to `tests/unit/command-table.test.ts`.

## Credential

`api-key` with two fields, collected by the host's generic form:

| Field     | Secret | Value                                                                                             |
| --------- | ------ | ------------------------------------------------------------------------------------------------- |
| `email`   | no     | The email of the Upstash account (or team member) owning the key. Basic auth user name.           |
| `api_key` | yes    | A Developer API key (Upstash console → Account → Developer API), Read/Write. Basic auth password. |

There is no OAuth app to register: the Upstash Developer API is reached with
HTTP Basic auth (`email:api_key`). The guide asks for a Read/Write key (a Read
Only key cannot run the write tools; the missions narrow what an agent may
do) and an expiration the person picks; Upstash does not say it back, so the
account page cannot warn before it. The check at paste (`verifyUpstashKey`)
asks `GET /v2/teams`. Revoke the key in the console to end the connection.

The per-database REST tokens (Data API) are **not** part of the credential:
`execute` reads them from `GET /v2/redis/database/{id}` at call time and
never returns them — Management API answers are redacted of `rest_token`,
`read_only_rest_token` and `password` before reaching the agent. The token
is posted to `https://<label>.upstash.io` only: the endpoint the Management
API names (`rest_url`, or `endpoint`) is reduced to its label and rebuilt
(`restEndpointOf`), and a database answer naming any other host, scheme,
port or path makes the call fail before anything is sent. A connection
made of per-database REST tokens was considered and rejected: it could
neither discover its databases nor reach the management tools.

What `execute` declines itself (a database outside the mission, a malformed
argument, a pipeline-shaped `command`) is an `isError` result; a provider
failure is thrown: a failed status (a command Redis refuses is the REST
endpoint's HTTP 400 `{ error }`), and an answer that is not JSON or not the
shape expected (`UpstreamProtocolError`), never passed to the agent as text.

## Catalog and macro-actions

Risks (ids are stable, never renamed): `read-database-metadata`,
`read-data`, `read-stats`, `write-data`¹, `delete-data`¹, `flush-database`¹,
`execute-arbitrary`¹, `create-database`, `delete-database`¹,
`modify-database`¹, plus the fallback `uncategorized-write`¹.
¹ env-scoped: `acceptable_in_envs: [development, staging, prod]`, qualified
as `upstash-redis[staging].write-data` etc. Reads and `create-database`
(account-rooted) stay account-scoped.

A creator ticks macro-actions at a trust level (Careful / Trusting / Autonomous),
risk model §4.6; the trust level writes the explicit lines, one per environment the
mission's databases carry.

| Macro-action | What it covers                                  | Its risks                                                                    |
| ------------ | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `peek`       | Metadata, stats and values.                     | `read-database-metadata`, `read-stats`, `read-data`                          |
| `write`      | Set keys.                                       | `write-data`                                                                 |
| `delete`     | Delete keys and flush the database.             | `delete-data`, `flush-database`                                              |
| `manage`     | Create, rename, delete, and arbitrary commands. | `create-database`, `modify-database`, `delete-database`, `execute-arbitrary` |

Base budgets are in the YAML. The fallback is in no macro-action: the gateway
offers it under "Anything else".

## Resources

`discoverResources` reads `GET /v2/redis/databases` (unpaged upstream,
capped at 200 with a logger warning) and returns one resource per database:
`{ provider: 'upstash-redis', ref: database_id, displayName: database_name,
metadata: { region, primary_region?, read_regions?, endpoint, state,
database_type, tls } }`. No token is copied into the metadata. The owner
labels `env`.

The database ref is a segment of the Management API path
(`/redis/database/{id}`), so it must be one path-safe segment:
`^[A-Za-z0-9_-]{1,64}$` (`pathIdent` in `src/classify.ts`). `classify` and
`execute` resolve it with the same `resolveDatabase`, from `databaseId` /
`database_id` or from the mission's single database; `.`, `..`, a `/` or any
other character is refused before any call. Redis keys, patterns and
command words are not identifiers of a URL: a command is posted as a JSON
array to the database's REST endpoint, so any string is a key.

## Tests

```
npx vitest run plugins/upstash-redis
```

`tests/unit/plugin.test.ts` runs the SDK kit (`assertPluginWellFormed`,
`assertNoWildcard`, `assertCatalogCoverage` with
samples for every tool), the classifier conventions, env resolution through
the resource label, the credential spec, and `execute` / `discoverResources`
against `mockFetch`. `classify.test.ts` pins the expected slice of every
tool and the denials; `command-table.test.ts` is the adversarial table of
the generic `execute` tool (one class per command, deletions in disguise,
unreadable commands, pipelines); `policy.test.ts` runs the shipped catalog
and missions written from its macro-actions through the engine
(`evaluateCall` with the gateway's env resolver): refusal on an unlabelled
database, what each mission allows and refuses. `risk-catalog.test.ts` lints the loaded catalog and its coverage of
every tool, `execute.test.ts` pins the request shapes sent upstream and the
pinned REST endpoint, and `identifiers.test.ts` feeds hostile database refs
to `classify` and `execute`. 313 tests; none reaches the network.
