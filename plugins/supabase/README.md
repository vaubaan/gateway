# `@vaubaan/plugin-supabase`

Provider plugin for [Supabase](https://supabase.com) : Postgres, Storage,
Auth (GoTrue) and Edge Functions of the company's projects, reached through
the Supabase **Management API** with the OAuth app the company registered.

Contract : `@vaubaan/plugin-sdk` (`definePlugin`, see
[`plugins/README.md`](../README.md) and the
[plugin-sdk handbook](../../docs/handbook/plugin-sdk.md)). Modelling handbook :
[`docs/handbook/providers/supabase.md`](../../docs/handbook/providers/supabase.md).

```
plugins/supabase/
  src/
    risk-catalog.yaml     24 risks + 1 deprecated + fallback, 3 presets (loaded at boot)
    data-model.ts         4 planes : db, storage, auth, functions ; the managed schemas
    tools.ts              44 MCP tools, prefix `supabase__`
    classify.ts           (tool, args, resources) → slices ; security-critical
    migration-sql.ts      allow-list reading of the SQL of apply_migration
    query-sql.ts          allow-list reading of the SQL of execute_sql
    sql-tokens.ts         the tokeniser both readers share
    execute.ts            Management API + data plane ; discoverResources
    credential.ts         oauth2 spec (the host runs the flow and the refresh)
    index.ts              definePlugin() — default export `supabasePlugin`
  tests/unit/             plugin.test.ts (kit), classify, execute, risk-catalog,
                          mission-evaluation (engine decisions, presets),
                          identifier-injection (hostile identifiers, both sides), data-model
```

## Data model

A **project** (`project_ref`, the 20-character id in `xxx.supabase.co`) is the
resource the connection owner labels with an environment. One project per
environment : staging and prod are distinct projects. Four planes hang under
it :

| Plane       | Entities                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db`        | `schema` → `table` → `row` (bounded / unbounded), `index`, `db-function`, `sequence`, `view`, `policy` (RLS), `db-role`, `publication`, `extension`, `migration`, `project-settings` |
| `storage`   | `bucket` → `object` (bounded / unbounded) → `signed-url`, `bucket-policy`, `storage-config`                                                                                          |
| `auth`      | `user` (bounded / unbounded) → `link`, `mfa-factor`, `identity` ; `sso-provider`, `third-party-auth`, `auth-config`                                                                  |
| `functions` | `edge-function` → `function-body`, `function-deployment` ; `function-secret` (project-wide), `functions-config`                                                                      |

`db-role` and `extension` have no tool of their own : `apply_migration`
reaches them (grants, roles, `CREATE EXTENSION`). Entities without any tool
today (`publication`, `bucket-policy`, `mfa-factor`, `identity`,
`functions-config`) are declared so a future tool lands on an existing risk
slot.

## Tools and classification

44 tools : 7 on `db`, 10 on `storage`, 17 on `auth`, 10 on `functions`.
Every tool takes `project_ref` ; when absent, the mission's single Supabase
project is used, and two or more projects without an explicit ref is a
denial. An explicit ref that is not a resource of the mission is denied by
the classifier before the gateway's own `resource-not-in-mission` check.

Rules a reviewer must know (`src/classify.ts`) :

- **One project resolution.** `resolveProjectRef(args, resources)` is the
  only code that decides the target project. `classify` and `execute` both
  call it ; `execute` builds every URL from its answer and returns an error
  result, without any request, on a denial. `project_ref` must be a host
  label (lowercase letters, digits and inner hyphens, 63 characters at
  most) : an array, an object or an unsafe string is denied, never coerced.
  The camelCase `projectRef` is refused outright.
  Never read `args.project_ref` anywhere else.
- **Cardinality markers.** The slice DSL has no cardinality, so the
  classifier emits literal identifiers : `row[bulk]`,
  `object[one]` / `object[bulk]`, `user[one]` / `user[bulk]`. The catalog
  patterns use the same literals, which makes `storage.object-write-one` and
  `storage.bulk-object-write` mutually exclusive. A single-user or single-object write
  emits the marker slice alone (`user[one].W`, `object[one].W`) : the id or
  path is validated but is not a slice segment, so the call never lands on
  the fallback.
- **`execute_sql` is read-only, and reads two kinds of schema.** The
  classifier emits `schema[any].row[bulk].R`, plus
  `schema[managed].row[bulk].R` when the query names a schema Supabase
  manages (`auth`, `vault`, `storage`…) or cannot be read with confidence
  (`src/query-sql.ts`, an allow-list : a function outside its inert list,
  `$$`, a statement that is not a plain query). The second slice is the
  risk `supabase.read-managed-schemas`, which no read-only preset carries.
  `execute.ts` enforces read-only by calling the Management API
  **read-only query endpoint**
  (`POST /v1/projects/{ref}/database/query/read-only`), where Postgres
  refuses any mutation. `list_tables` and `list_migrations` use the same
  endpoint. Consequence : no tool writes rows one by one, so
  `supabase.row-write-one` matches no call ; it is `deprecated: true`, kept
  so the id resolves where a share or a mission names it.
- **`apply_migration` reads its SQL against an allow-list**
  (`src/migration-sql.ts`). Always `schema[any].table[any].W`
  (→ `migration-write`) ; plus `row[bulk].W` for DML, `DROP TABLE`, a
  dropped column or a column type change (`ALTER COLUMN … TYPE` / `USING`
  rewrites every row), `policy[any].W` for RLS statements, `db-role[any].W` for
  grants and roles, `extension[any].W` for extensions. **One statement that
  is not recognised** — a `DO` block or any `$$` body, a function, trigger
  or view, a CTE, a bare `SELECT`, `SET`, `COPY`, a write on a
  Supabase-managed schema, text it cannot tokenise — **and all five slices
  are emitted.** It fails closed ; widening the allow-list needs a test in
  `classify.test.ts`. A `query` that is not a non-blank string is denied.
  A line comment ends at `\n` or `\r`, as PostgreSQL reads it.
- **Cascades.** `delete_bucket` emits the bucket write and the bulk object
  write (the objects go with it) ; `deploy_function` always emits the
  deployment and the body write, with or without `files` (a deployment
  changes what runs and how it is exposed) ; a `files` that is not an array
  is denied.
- **Only declared arguments.** `execute` builds most request bodies from the
  arguments, so an argument the tool's schema does not declare is denied by
  the classifier (`undeclaredArgumentDenial` of the SDK) and therefore
  refused by `execute`, which classifies first. To add an argument, declare
  it in `tools.ts` and classify it.
- **Identifiers the slice grammar cannot carry** (a bucket id, a secret name
  or an e-mail address holding `@`, `+` or `:`) are written `[*]` in the
  slice : the call is classified on every instance of the entity. The
  request still carries the value itself.
- **Identifiers** have one grammar per kind, read by `readIdentifiers`
  for the classifier and the executor alike, so the request names what the
  slices named. Opaque ids and slugs (`user_id`, `provider_id`, `tpa_id`,
  `function_slug`, `slug`, `type`) are one path segment
  `[A-Za-z0-9_-]{1,64}` ; a bucket id may hold dots but is never `.` / `..`
  nor a separator ; an object path is `/`-separated segments, none empty or
  dot-only ; an email has one `@` and a dotted domain ; `project_ref` is a
  host label ; `list_tables` schemas are unquoted SQL identifiers ;
  `list_users` pages are positive integers ; `content_type` is a media
  type ; `content_base64` is base64 text (required : the bytes stored) ; the
  `type` of `get_advisors` is `security` or `performance`. Anything else, or
  a missing required identifier, is a denial and an `isError` refusal before
  any request — never escaped, never a broad slice.

`supabase__get_anon_key` returns the project URL and the anon key ;
`service_role` is fetched gateway-side for the data-plane tools and never
surfaced.

## Catalog

`src/risk-catalog.yaml`, `catalog_version: 4`, 25 named risks — 24 live and
the deprecated `supabase.row-write-one` — + the fallback
`supabase.uncategorized-write` (`supabase.**.W`). A risk is never renamed or
deleted, only deprecated.

**Every write risk is env-scoped** (`acceptable_in_envs`) : a mission accepts
`supabase[staging].migration-write`, never a bare `supabase.migration-write`,
and the environment comes from the label the owner put on the project.
Reads are account-scoped except `auth.read-users` (PII) and
`read-managed-schemas` (identities and secrets read through SQL).

The runtime **refuses** a call that touches an env-scoped risk on a project
whose label is absent or outside the risk's `acceptable_in_envs` ; the risk
is not dropped. So :

- on a project the owner has **not labelled**, every write, every user
  read (`list_users`, `get_user`) and every SQL read of a managed schema is
  refused ; only account-scoped reads go through ;
- the three bulk risks (`bulk-row-write`, `storage.bulk-object-write`,
  `auth.bulk-user-write`) list `preview` and `staging` only, so **a bulk
  write is refused on a prod project whatever the mission accepted** : a
  migration that writes rows, drops a table or a column or changes a column
  type, a migration the reader does not recognise, a bucket delete.

The fallback counts only when no specific entry matched the write
(policy-engine rule). Presets never carry it ; a creator who
accepts it for an environment accepts every uncategorized write there, which
should stay the exception.

## Presets

| Preset               | Intent                                                                                                                    | Writes                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `read-only-analyst`  | Query data and schema, list buckets and objects, on every project. No PII user listing.                                   | none                                                                                                                           |
| `staging-developer`  | One mission per application : development on `staging` projects, reads of data, schema, objects and functions everywhere. | on `[staging]`, `gate: auto` : migrations of any kind, RLS, buckets, objects, users one by one, links, edge functions, secrets |
| `migration-operator` | Migrations : any on `staging` ; on prod, plain schema changes and RLS changes only, each gated.                           | `[staging]` auto (the five db write risks) ; `[prod].migration-write`, `[prod].policy-write` on `approval`                     |

`staging-developer` carries no auth, storage, SSO or third-party-auth
configuration write, no bulk user write and no signed URL.
`mission-evaluation.test.ts` asserts, call by call, what each preset allows
and refuses on staging, prod and unlabelled projects.

Presets are UI sugar : the persisted policy is always the explicit list of
risk ids, quotas, rate limits and gates (spec §3.2). The numbers are
provisional until the `mission-presets-default-values` ADR.

## Credential — the company's Supabase OAuth app

`credential.kind: 'oauth2'`, `refreshable: true` :

| Field              | Value                                                |
| ------------------ | ---------------------------------------------------- |
| `authorizationUrl` | `https://api.supabase.com/v1/oauth/authorize`        |
| `tokenUrl`         | `https://api.supabase.com/v1/oauth/token`            |
| `scopes`           | `['all']` (the app's scopes are set at registration) |
| `pkce`             | `true` (S256)                                        |
| `clientAuthMethod` | `client_secret_basic`                                |

### Registering the app (once per company)

1. In the Supabase dashboard, open your organization → **OAuth Apps**
   (`https://supabase.com/dashboard/org/<slug>/apps`) and create an app.
2. Set the redirect URL to the callback the instance shows in
   Settings → Administration → Company apps (it is derived from the
   instance `public_url`).
3. Pick the scopes the company is ready to grant the gateway. The plugin
   needs `database:read` for the read-only tools, `database:write` for
   migrations, `secrets:read` for the data-plane tools (it reads the
   project `service_role` key through the Management API), and the
   `auth`, `storage`, `edge_functions`, `environment`, `organizations` and
   `projects` scopes for the corresponding tools and for discovery.
4. Enter the **client id** and **client secret** in the instance
   configuration (Settings → Administration → Company apps). The host uses them for the
   authorization-code flow and for refresh ; the plugin reads neither, and
   nothing from the environment.

Connecting is then one click : the host runs the authorization-code flow
from the spec above and stores the token pair encrypted. Access tokens live
one hour ; the host refreshes them with the standard `refresh_token` grant
and HTTP Basic client authentication (the refresh token rotates), and owns
the refresh timing. A 401/403 upstream throws `UpstreamAuthError`, which
also triggers a refresh in the host.

### Resource discovery

`discoverResources` lists `GET /v1/organizations` and `GET /v1/projects` and
returns one `Resource` per project : `ref` = project ref, `displayName` =
`<organization> / <project>`, `metadata` = organization, region, status.
The Management API returns the whole list (no paging) ; the plugin caps it
at `MAX_DISCOVERED_PROJECTS` (200) and warns through the logger. The owner
labels each project's `env` on the account's page (Accounts).

## Credential, the other way: a personal access token

Without a company OAuth app — or beside it — an account is connected with a
**personal access token** pasted by hand (`supabaseTokenCredential`,
`src/token.ts`). Create it at https://supabase.com/dashboard/account/tokens,
as the account the agents will act as (a shared service account is fine),
**scoped** to the organisation and projects the missions need, with the
permissions the connect page lists (`guide.permissions`) and an expiry. Every
tool runs with it. The gateway checks it with `GET /v1/organizations` and
seals it; Supabase exposes no expiry and no deletion endpoint for these
tokens, so removing the account tells the person to delete it under Account
preferences → Access tokens. ADR
[`one-place-to-authorize-services-token-first`](../../docs/decisions/one-place-to-authorize-services-token-first.md).

## Tests

`npx vitest run plugins/supabase` — `plugin.test.ts` runs the SDK kit
(`assertPluginWellFormed`, `assertPresetsValid`, `assertNoWildcard`,
`assertCatalogCoverage` with samples per tool and an empty `fallbackHits`),
the credential spec, `execute` and `discoverResources` against `mockFetch`,
and the presets ; `risk-catalog.test.ts` lints the loaded catalog and binds
tools to their exact risks ; `classify.test.ts` is the classifier's security
suite (expected slices per tool family, the adversarial SQL table, the
denials) ; `execute.test.ts` pins the request shapes, the target-project
resolution and the body built from declared arguments only ;
`mission-evaluation.test.ts` runs the engine's `evaluateCall` on the real
catalog (unlabelled project, bulk writes on prod, each preset) ;
`identifier-injection.test.ts` feeds hostile values to every identifier
position of `classify` and `execute`. 1740 tests ; none ever reaches
Supabase.
