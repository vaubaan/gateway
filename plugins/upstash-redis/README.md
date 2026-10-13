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

| File                    | Role                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`          | `definePlugin({...})` — default export `upstashRedisPlugin`.                                                                   |
| `src/risk-catalog.yaml` | 10 risks + fallback, three presets, `catalog_version: 3`. Loaded at boot by the SDK; the only catalog artefact.                |
| `src/data-model.ts`     | One plane `cache`, 6 entities; `database` is the env-scopable entity (the resource).                                           |
| `src/tools.ts`          | 21 custom tools: 6 management (Management API) + 15 data (per-database REST).                                                  |
| `src/classify.ts`       | `(tool, args, resources) → slices`. Pure. Database resolution against the mission's resources; the command table of `execute`. |
| `src/credential.ts`     | `api-key` spec: account email + Management API key; `upstashAuth()` narrows the secret.                                        |
| `src/execute.ts`        | Management API (Basic auth) and Data API (per-database Bearer), redaction, `discoverResources`.                                |

`src/index.ts` resolves the YAML path with the SDK helper
`catalogPathNextTo(import.meta.url)`, not with
`new URL('./risk-catalog.yaml', import.meta.url)`: the bundler rewrites that
pattern into an asset URL that Node's `fileURLToPath` rejects (ADR
`plugin-catalog-path-and-standalone-tracing`).

## Data model

```
account ─ database[<id>] ─┬─ key-space[<key>] ─┬─ delete     (DEL, UNLINK, HDEL, LPOP, EXPIRE 0… marker)
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

| Command                                                           | Risks needed (in the database's environment) |
| ----------------------------------------------------------------- | -------------------------------------------- |
| read (`GET`, `SCAN`, `HGETALL`…)                                  | `read-data`                                  |
| write (`SET`, `INCR`, `HSET`, `EXPIRE k 60`…)                     | `write-data`                                 |
| delete (`DEL`, `UNLINK`, `GETDEL`, `HDEL`, `LPOP`, `EXPIRE k 0`…) | `write-data` + `delete-data`                 |
| `FLUSHDB` / `FLUSHALL`                                            | `write-data` + `flush-database`              |
| script, administration, unknown or unreadable command             | `write-data` + `execute-arbitrary`           |
| a pipeline or MULTI / EXEC body                                   | the union over its commands                  |

A command the classifier cannot read is never cheaper than the catch-all.
The executor sends exactly what was classified (`redisCommandOf`) and
refuses a pipeline-shaped `command`: no pipeline endpoint is wired. To add a
verb, put it in exactly one set (a verb listed twice fails the import) and
add a row to `tests/unit/command-table.test.ts`.

## Credential

`api-key` with two fields, collected by the host's generic form:

| Field     | Secret | Value                                                                                   |
| --------- | ------ | --------------------------------------------------------------------------------------- |
| `email`   | no     | The email of the Upstash account (or team member) owning the key. Basic auth user name. |
| `api_key` | yes    | A Management API key (Upstash console → Account → Management API). Basic auth password. |

There is no OAuth app to register: the Upstash Developer API is reached with
HTTP Basic auth (`email:api_key`). The key does not expire (`refresh` is absent); revoke it in
the console to end the connection.

The per-database REST tokens (Data API) are **not** part of the credential:
`execute` reads them from `GET /v2/redis/database/{id}` at call time and
never returns them — Management API answers are redacted of `rest_token`,
`read_only_rest_token` and `password` before reaching the agent. A connection
made of per-database REST tokens was considered and rejected: it could
neither discover its databases nor reach the management tools.

## Catalog and presets

Risks (ids are stable, never renamed): `read-database-metadata`,
`read-data`, `read-stats`, `write-data`¹, `delete-data`¹, `flush-database`¹,
`execute-arbitrary`¹, `create-database`, `delete-database`¹,
`modify-database`¹, plus the fallback `uncategorized-write`¹.
¹ env-scoped: `acceptable_in_envs: [development, staging, prod]`, qualified
as `upstash-redis[staging].write-data` etc. Reads and `create-database`
(account-rooted) stay account-scoped.

| Preset      | Intent                                                                                      | Approval-gated by default                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `read-only` | Inspect databases, stats and key-value data.                                                | —                                                                                                           |
| `developer` | Key-level reads/writes with TTL and targeted deletions on `development` and `staging`.      | — (no FLUSH, no arbitrary command, no management write, nothing on `prod`)                                  |
| `operator`  | Developer plus `prod` key writes, FLUSH, arbitrary commands, database create/delete/rename. | FLUSH and arbitrary commands on `staging` / `prod`, every database deletion, every rename, `prod` deletions |

Budgets are per period; see the YAML for the numbers. Presets are UI sugar;
the persisted mission policy is always the explicit enumeration. No preset
carries the fallback.

## Resources

`discoverResources` reads `GET /v2/redis/databases` (unpaged upstream,
capped at 200 with a logger warning) and returns one resource per database:
`{ provider: 'upstash-redis', ref: database_id, displayName: database_name,
metadata: { region, primary_region?, read_regions?, endpoint, state,
database_type, tls } }`. No token is copied into the metadata. The owner
labels `env`.

## Tests

```
npx vitest run plugins/upstash-redis
```

`tests/unit/plugin.test.ts` runs the SDK kit (`assertPluginWellFormed`,
`assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage` with
samples for every tool), the classifier conventions, env resolution through
the resource label, the credential spec, and `execute` / `discoverResources`
against `mockFetch`. `classify.test.ts` pins the expected slice of every
tool and the denials; `command-table.test.ts` is the adversarial table of
the generic `execute` tool (one class per command, deletions in disguise,
unreadable commands, pipelines); `policy.test.ts` runs the shipped catalog
and presets through the engine (`evaluateCall` with the gateway's env
resolver): refusal on an unlabelled database, what each preset allows and
refuses. `risk-catalog.test.ts` lints the loaded catalog and its coverage of
every tool, and `execute.test.ts` pins the request shapes sent upstream. No
test reaches the network.
