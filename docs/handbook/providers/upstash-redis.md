---
title: Upstash Redis provider — plugin on the v5 SDK
status: current
date: 2026-10-13
last_synced: 2026-10-14
tracks:
  - plugins/upstash-redis/src/index.ts
  - plugins/upstash-redis/src/classify.ts
  - plugins/upstash-redis/src/credential.ts
  - plugins/upstash-redis/src/data-model.ts
  - plugins/upstash-redis/src/execute.ts
  - plugins/upstash-redis/src/risk-catalog.yaml
  - plugins/upstash-redis/src/tools.ts
  - plugins/upstash-redis/tests/unit/
---

# Upstash Redis provider — plugin and risk model

`@vaubaan/plugin-upstash-redis` (`plugins/upstash-redis`, version 3.0.0),
written against the Plugin SDK. Spec: [`vaubaan-gateway.md`](../../spec/vaubaan-gateway.md)
§5 (plugins), §3.2 (presets); [`gateway-risk-model.md`](../../spec/gateway-risk-model.md)
§2, §4, §7. ADR: [[plugin-contract-and-credential-spec]]. Contributor guide:
[`plugins/upstash-redis/README.md`](../../../plugins/upstash-redis/README.md).

Three modelling choices shape everything below: two API layers under one
plane, a command table that routes the generic `execute` tool, and dedicated
risks for deletion, flush and arbitrary execution.

## 1. Data model

One plane, `cache`. The **database** is the resource; the **environment** is
the owner's label on it.

```mermaid
flowchart TB
  account --> db["database[id]  (resource, envScopable)"]
  db --> ks["key-space[key]"]
  ks --> del[delete]
  ks --> flush[flush]
  ks --> exec[execute]
  db --> cred[credentials]
  db --> stats
  db --> backup
```

| Entity                 | Cardinality | Notes                                                                                                   |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `account`              | one         | The account behind the Management API key of a connection.                                              |
| `database`             | bounded     | The resource (`ref` = Upstash database id). Discovered at connection time; labelled by the owner.       |
| `key-space`            | unbounded   | All Redis data structures. `delete`, `flush`, `execute` are literal markers appended by the classifier. |
| `credentials`, `stats` | one         | Rename touches `credentials`; `stats` is read-only.                                                     |
| `backup`               | bounded     | Declared, no tool yet.                                                                                  |

## 2. Tools → slices

21 custom tools (`src/tools.ts`), no upstream MCP server. The classifier
(`src/classify.ts`) is pure. A dedicated tool emits exactly one slice; the
generic `execute` tool emits one slice per class of command it carries (one
for a single command, several for a pipeline-shaped `command`).

**Database resolution.** `databaseId` (or `database_id`) must be a resource
of the mission; absent, the mission's single Upstash database applies;
several databases and no argument, a database the mission does not hold, or
a malformed ref are refused. Two account-level tools need no database
(`list_databases`, `create_database`) but still refuse a foreign `databaseId`.

**Identifiers.** The database ref is the one identifier that reaches a URL:
it is a segment of the Management API path (`/redis/database/{id}`,
`/redis/rename/{id}`, `/redis/stats/{id}`) and of the slice. One function
reads it, `pathIdent` (`PATH_IDENT = ^[A-Za-z0-9_-]{1,64}$`, in
`classify.ts`), inside `resolveDatabase`, which `classify` and `execute`
both call: the ref it returns — from the argument or from the mission's
single database — is what the slice names and what is interpolated into the
path, as it is; the argument is not read a second time. `.`, `..`, a `/`,
an encoded form, an empty or overlong value is refused
(`databaseId: malformed database ref`), never escaped:
`encodeURIComponent` leaves `..` untouched and a URL parser would turn
`/redis/database/..` into `/redis/`. Rule: ADR
[`plugin-identifiers-one-grammar-for-classify-and-execute`](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md).

| Value                                           | Grammar                                           | Where it lands                                         | Outside the grammar                   |
| ----------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ | ------------------------------------- |
| `databaseId` / `database_id`, the database ref  | `pathIdent`, through `resolveDatabase`            | Management API path, slice `database[D]`               | refused by `classify` and `execute`   |
| `key` of a dedicated data tool                  | `KEY_IDENT` — `[a-zA-Z0-9_./~-]{1,128}` (private) | slice `key-space[K]` only; JSON array in the POST body | `key-space[*]`; the key is sent as is |
| patterns, command words, values (`execute` too) | none — never part of a URL                        | JSON array in the POST body                            | —                                     |

| Tool                                                      | Slice                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `list_databases`                                          | `account.database[*].R`                                      |
| `get_database`                                            | `database[D].R`                                              |
| `get_database_stats`                                      | `database[D].stats.R`                                        |
| `create_database`                                         | `account.database.W`                                         |
| `delete_database`                                         | `account.database[D].delete.W`                               |
| `rename_database`                                         | `database[D].credentials.W`                                  |
| `get`, `ttl`, `hgetall`, `lrange`, `smembers`             | `database[D].key-space[K].R`                                 |
| `keys`, `scan`, `dbsize`                                  | `database[D].key-space[*].R` (the whole key space, always)   |
| `set` without `ex` / `px`, `hset`, `lpush`, `sadd`        | `database[D].key-space[K].W`                                 |
| `set` with `ex` or `px` (whatever the value)              | `database[D].key-space[K].delete.W`                          |
| `expire` (whatever `seconds` is)                          | `database[D].key-space[K].delete.W`                          |
| `del`                                                     | `database[D].key-space[K].delete.W` (`[*]` for several keys) |
| `execute` — read command                                  | `database[D].key-space[*].R`                                 |
| `execute` — write command                                 | `database[D].key-space[*].W`                                 |
| `execute` — delete command                                | `database[D].key-space[*].delete.W`                          |
| `execute` — FLUSHDB / FLUSHALL                            | `database[D].key-space.flush.W`                              |
| `execute` — script, administration, unknown or unreadable | `database[D].key-space[*].execute.W`                         |

**Keys.** A key is embedded as `[K]` when it is a slice-DSL ident of at
most 128 characters (`[a-zA-Z0-9_./~-]{1,128}`); glob patterns, braces,
keys with `:` (`session:123`) and overlong keys fall back to `[*]`, because
a slice embedding them would not parse back. The catalog patterns match any
ident there, so only audit precision is lost. `keys`, `scan` and `dbsize`
send no `key`: they read the whole key space and are classified on `[*]`
whatever else the call carries. A key never reaches a URL — the command
travels as a JSON array in the body — so any string is a key.

### The command table of `execute`

The rule: **the same Redis command costs the same risk whichever tool carries
it**, and a command the classifier cannot read is never cheaper than the
catch-all. Every command belongs to exactly one class; the six sets are
exported from `classify.ts`, and a verb listed in two of them fails the
import (that is, the gateway boot).

| Class       | Set                 | Marker     | Risk touched (next to `write-data` for every write)           | What is in it                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------- | ---------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`      | `KNOWN_READS`       | —          | `read-data` (next to `read-database-metadata`, as every read) | Commands that change nothing: GET, MGET, SCAN, HGETALL, LRANGE, ZRANGE, XRANGE, JSON.GET, INFO, PING…                                                                                                                                                                                                                           |
| `write`     | `KNOWN_WRITES`      | —          | `write-data`                                                  | Create, overwrite, modify a value that stays: SET without an expiry, MSET, INCR, HSET, LPUSH, SADD, ZADD, PERSIST, COPY, XADD, JSON.SET…                                                                                                                                                                                        |
| `delete`    | `KNOWN_DELETES`     | `.delete`  | `delete-data`                                                 | Remove keys, fields, members or entries, now or later: DEL, UNLINK, GETDEL, HDEL, LPOP, RPOP, LREM, LTRIM, SREM, SPOP, ZREM, ZPOPMIN, XDEL, XTRIM, JSON.DEL…; **every expiry** (EXPIRE, PEXPIRE, HEXPIRE, SETEX, PSETEX, the `…AT` forms, GETEX); **the moves** (RENAME, RENAMENX, LMOVE, RPOPLPUSH, BLMOVE, BRPOPLPUSH, SMOVE) |
| `flush`     | `KNOWN_DESTRUCTIVE` | `.flush`   | `flush-database`                                              | FLUSHDB, FLUSHALL.                                                                                                                                                                                                                                                                                                              |
| `arbitrary` | `KNOWN_ARBITRARY`   | `.execute` | `execute-arbitrary`                                           | Code and sequences the classifier does not see: EVAL, EVALSHA, FCALL, FUNCTION, SCRIPT, MODULE, and transaction control alone (MULTI, EXEC, DISCARD, WATCH…).                                                                                                                                                                   |
| `admin`     | `KNOWN_ADMIN`       | `.execute` | `execute-arbitrary`                                           | Server, connection and replication administration: CONFIG, ACL, CLIENT, DEBUG, SHUTDOWN, REPLICAOF, SWAPDB, MIGRATE, SELECT…                                                                                                                                                                                                    |
| (unknown)   | none                | `.execute` | `execute-arbitrary`                                           | Any verb the table does not hold, and any `command` that is not one readable command.                                                                                                                                                                                                                                           |

Edge cases, all on the severe side:

- **Whatever makes data go away is a deletion, at once or later**
  (decision of 2026-10-13). `KNOWN_DELETES`
  holds **every expiry**, relative (`EXPIRE`, `PEXPIRE`, `HEXPIRE`,
  `HPEXPIRE`, `SETEX`, `PSETEX`) and absolute (`EXPIREAT`, `PEXPIREAT`,
  `HEXPIREAT`, `HPEXPIREAT`, `GETEX`): the key or the field is gone when the
  time elapses, and a time to live of one second is a deletion in all but
  name. It holds **the moves** (`RENAME`, `RENAMENX`, `LMOVE`, `RPOPLPUSH`,
  `BLMOVE`, `BRPOPLPUSH`, `SMOVE`): the source key, or the element taken from
  it, is no longer where it was. And the `*STORE` family and `BITOP`: an
  empty result deletes the destination key. Before this decision a positive
  TTL and a move were plain writes, so a mission that held `write-data` alone
  could delete any key with `EXPIRE k 1`.
- **Writes that become deletions on their arguments** (`ESCALATIONS`):
  `SET … EX|PX|EXAT|PXAT` (any expiry; `KEEPTTL` is not one);
  `XADD … MAXLEN|MINID`; `SORT`, `GEORADIUS`, `GEORADIUSBYMEMBER` with
  `STORE` / `STOREDIST`. An option name found where a value may sit counts
  as the option. The dedicated `set` tool reads the same way: `ex` or `px`
  present, whatever the value, is the `delete` marker — the executor appends
  the option whenever the argument is present.
- **What it costs.** A cache write with a time to live (`SET k v EX 300`,
  `SETEX`) needs `delete-data` next to `write-data`. The `developer` and
  `operator` presets hold both wherever they hold one; in `operator`,
  `[prod].delete-data` is behind approval, so a TTL write on prod waits for
  the creator.
- **Reading the verb.** A command name is ASCII (`[A-Za-z][A-Za-z0-9._-]*`)
  and is then matched case-insensitively. Anything else — a space, a
  newline, a letter of another script that upper-cases to an ASCII one
  (`ſet`, `ınfo`) — is not a known verb.
- **Reading the command** (`redisCommandOf`, shared with the executor): a
  flat, non-empty array whose first element is a non-empty string and whose
  other elements are strings or finite numbers (rendered as text). A missing
  or empty `command`, a string, an object, a `null` or boolean element, a
  non-string verb, a nested array among the words: unreadable, hence the
  catch-all.
- **Pipelines and MULTI / EXEC bodies.** A `command` whose elements are all
  arrays is a body: each command is classified and the call costs the union
  of the classes, one slice per class, least severe first
  (`classifyRedisCommands`). An unreadable command in the body is
  `arbitrary`. Transaction-control verbs add nothing to the commands they
  wrap; a body with nothing else is `arbitrary`. The executor does not run
  bodies today (§4) — the classification does not rely on that refusal.
- **What `write-data` still allows.** Overwriting a value or renaming over a
  key destroys the previous content without touching `delete-data`; that is
  what a Redis write is, and the `write-data` reason says so.
- **What `execute-arbitrary` means.** A script can delete or flush, and the
  classifier does not read scripts: accepting `execute-arbitrary` in an
  environment accepts everything a Redis command can do there. The `operator`
  preset therefore gates it like FLUSH (`approval` outside `development`).

## 3. Catalog and presets (`src/risk-catalog.yaml`, v5)

Risk ids are stable and never renamed. `write-data` (`key-space[**].W`) is
deliberately broad: the deletion commands (DEL, UNLINK, the POP and REM
families, an expiry at an absolute instant), FLUSH and arbitrary commands
fire it next to their own, more severe risk, so a mission accepting
`write-data` alone cannot run them, and a deletion needs both `write-data`
and `delete-data`. So do the commands that make data go away later or
elsewhere — any time to live (EXPIRE, SETEX, `SET … EX`) and the moves
(RENAME, LMOVE, SMOVE): `write-data` alone writes and overwrites values that
stay, nothing else.

Ten named risks and the fallback: `read-database-metadata`, `read-stats`,
`read-data`, `write-data`, `delete-data`, `flush-database`, `execute-arbitrary`,
`create-database`, `delete-database`, `modify-database`, and
`uncategorized-write`. `read-database-metadata` (`upstash-redis.[**].R`) is the
read baseline: every read of the provider fires it, so a key read needs it next
to `read-data`, and `get_database_stats` needs it next to `read-stats`.

- **Every write risk is env-scoped** (`acceptable_in_envs: [development,
staging, prod]`) except `create-database`, which is account-rooted (the
  new database is not a resource yet). Reads are account-scoped.
- **A write on a database with no label, or with a label outside that list,
  is refused** whatever the mission accepts: the engine does not drop an
  env-scoped risk it cannot place, it refuses the call
  (`packages/policy-engine/src/risk-runtime.ts`). The refusal names the
  unqualified risk (`upstash-redis.write-data`) or the misplaced one
  (`upstash-redis[dev].write-data`) and the accepted labels. Reads still pass.
- The fallback `uncategorized-write` is env-scoped and counts only when no
  specific entry matched (policy-engine rule); no preset carries it.
- Presets: `read-only` (the three reads); `developer` (reads, `[development]`
  and `[staging]` `write-data` and `delete-data`, all `auto`); `operator`
  (everything: `prod` key writes `auto`, `[development].flush-database` and
  `[development].execute-arbitrary` `auto`, `approval` on FLUSH and on
  arbitrary execution in `staging`/`prod`, every `delete-database`, every
  `modify-database`, `[prod].delete-data`). Values provisional until ADR
  `mission-presets-default-values`.
- `tests/unit/policy.test.ts` runs each preset through the engine: what it
  allows and refuses per environment, by the dedicated tools and by
  `execute`.

## 4. Execution and discovery (`src/execute.ts`)

- Management API base `https://api.upstash.com/v2`, HTTP Basic auth built
  from the two credential fields (`basicAuthHeader`).
- Data tools first read `GET /v2/redis/database/{id}` for `rest_url` (or,
  when it is absent, `endpoint`) and `rest_token`, then `POST` the command as
  a JSON array with `Authorization: Bearer <rest_token>`. The token is never
  returned.
- **The REST endpoint is pinned to Upstash.** The database token is posted
  there, so the answer of the Management API is not trusted to choose the
  destination: `restEndpointOf(named)` rebuilds `https://<label>.upstash.io`
  (`UPSTASH_REST_HOST_SUFFIX`) from the label alone. What the API names may
  be a URL, a host or a bare slug; a URL must be `https`, with no port, no
  userinfo, no path, no query and no fragment, and the label must be one DNS
  label (lowercase letters, digits, inner hyphens, 63 characters at most).
  Anything else — another host, `http`, a port, a path — is `null`: the
  executor throws "the Management API named a host that is not an Upstash
  REST endpoint (expected `https://<name>.upstash.io`); the call was not
  sent", and the token goes nowhere.
- `execute` sends the command exactly as the classifier read it
  (`redisCommandOf`): one flat command. A pipeline-shaped or otherwise
  unreadable `command` is an `isError` result before any network call — no
  pipeline endpoint is wired.
- Management API answers about a database are redacted (`rest_token`,
  `read_only_rest_token`, `password`) before reaching the agent.
- The database is resolved by the classifier's own `resolveDatabase` (§2):
  a `databaseId` that is not one path segment or not a mission resource, or
  a data tool on a mission holding several databases without `databaseId`,
  is an `isError` result carrying the classifier's refusal, before any
  network call, like every malformed argument (the SDK's `ExecutorRefusal`,
  thrown inside the executor and turned into the result at its entry
  point). A management tool acts on the database the call names:
  the mission's single database is not a default for it. A provider failure
  is **thrown**: 401/403 on either
  surface → `UpstreamAuthError` (the host treats a 401 as a rejected
  credential, a 403 as a failed call), any other failed status →
  `UpstreamHttpError` with the status, a database whose answer exposes no
  REST endpoint or token, or names a REST host that is not Upstash's → a
  plain `Error`, a network failure → as it comes.
  The host records it as `upstream_error` in the audit and tells the agent
  `Upstream error: …`; none of them is an `isError` result.
- `discoverResources`: `GET /v2/redis/databases` (unpaged upstream, capped
  at `MAX_DISCOVERED_DATABASES` = 200 with a logger warning) → one resource
  per database with `metadata: { region, primary_region?, read_regions?,
endpoint, state, database_type, tls }`; the owner labels `env`.

## 5. Credential (`src/credential.ts`)

`api-key`: `email` (not secret, loose email pattern) + `api_key` (secret),
created in the Upstash console → Account → Management API. No OAuth app, no
refresh.

## 6. Tests

`npx vitest run plugins/upstash-redis` — 313 tests: `plugin.test.ts` (27:
SDK kit with samples for every tool, presets, classifier conventions, env
resolution through `resourceEnvResolver`, credential spec, execute and
discovery against `mockFetch`), `classify.test.ts` (31: the expected slice
of every tool, denials), `command-table.test.ts` (105: the adversarial table
of `execute` — one class per command, deletions in disguise, unreadable
verbs and commands, pipelines and MULTI / EXEC bodies, the dedicated tools
against the same command through `execute`), `policy.test.ts` (25: the
shipped catalog and presets through `evaluateCall` with the gateway's env
resolver — refusal on an unlabelled or mislabelled database, what each
preset allows and refuses), `risk-catalog.test.ts` (49: schema, pattern and
per-tool coverage lint of the loaded catalog), `execute.test.ts` (33:
request shapes of the management tools, the Redis commands of the data
tools, refusal of a command that is not one readable command, the REST
endpoint pinned to `https://<label>.upstash.io` — the forms accepted and
every other host, scheme, port or path refused with nothing sent),
`identifiers.test.ts` (42: the grammar of a database ref, hostile refs fed
to `classify` and to `execute` for every tool that names a database, keys
and command words that stay in the JSON body), `data-model.test.ts` (1).

## 7. How to debug

- **`Invalid risk catalog` at boot** — read every bullet; paths are exact. An
  env-qualified preset entry on a risk without `acceptable_in_envs` is the
  usual cause after adding a risk.
- **A key write is refused with `risk-not-accepted` although the mission
  holds the database and the risk** — the database has no env label (the
  hint reads "touched on a resource with no environment label") or a label
  outside `development` / `staging` / `prod` (`dev` is not `development`).
  Label it on the account's page (Accounts).
- **A `DEL`, an `LPOP`, an `EXPIRE k 60`, a `SET k v EX 60` or a `RENAME`
  is refused with `delete-data` missing** — intended: removing data, now or
  when a time to live elapses, needs `delete-data` whichever tool carries
  the command. A cache that writes with a TTL needs both risks.
- **`execute` lands on `execute-arbitrary` for a harmless verb** — the verb
  is not in the command table. Add it to exactly one set in `classify.ts`
  (`KNOWN_READS` only if no argument can make it write), add a row to
  `tests/unit/command-table.test.ts`, bump the plugin minor version.
- **`the Management API named a host that is not an Upstash REST
endpoint`** — the database answer carries a `rest_url` / `endpoint` outside
  `https://<label>.upstash.io`. Nothing was sent. A regional or custom REST
  domain Upstash introduces needs a change of `restEndpointOf`, with its
  tests.
- **`mockFetch: unexpected POST https://…upstash.io`** — the data route in
  the test must match the pinned endpoint, `https://<label>.upstash.io`,
  whatever form the database route returned.
