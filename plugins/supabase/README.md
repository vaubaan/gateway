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
    risk-catalog.yaml     24 risks + fallback, 3 presets (loaded at boot)
    data-model.ts         4 planes : db, storage, auth, functions
    tools.ts              44 MCP tools, prefix `supabase__`
    classify.ts           (tool, args, resources) → slices ; security-critical
    execute.ts            Management API + data plane ; discoverResources
    credential.ts         oauth2 spec, refresh, refresh threshold
    index.ts              definePlugin() — default export `supabasePlugin`
    risk-classifier.ts    legacy v4 shim (deleted in P1.6)
    supabase-adapter.ts   legacy v4 shim (deleted in P1.6)
  tests/unit/             plugin.test.ts (kit), risk-catalog, risk-classifier, adapter, data-model
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

Entities without a tool today (`db-role`, `extension`, `publication`,
`bucket-policy`, `mfa-factor`, `identity`, `functions-config`) are declared
so a future tool lands on an existing risk slot.

## Tools and classification

44 tools : 7 on `db`, 10 on `storage`, 17 on `auth`, 10 on `functions`.
Every tool takes `project_ref` ; when absent, the mission's single Supabase
project is used, and two or more projects without an explicit ref is a
denial. An explicit ref that is not a resource of the mission is denied by
the classifier before the gateway's own `resource-not-in-mission` check.

Rules a reviewer must know (`src/classify.ts`) :

- **Cardinality markers.** The slice DSL has no cardinality, so the
  classifier emits literal identifiers : `row[one]` / `row[bulk]`,
  `object[one]` / `object[bulk]`, `user[one]` / `user[bulk]`. The catalog
  patterns use the same literals, which makes `row-write-one` and
  `bulk-row-write` mutually exclusive.
- **`execute_sql` is read-only.** The classifier always emits
  `schema[any].row[bulk].R` ; `execute.ts` enforces it by calling the
  Management API **read-only query endpoint**
  (`POST /v1/projects/{ref}/database/query/read-only`), where Postgres
  refuses any mutation. `list_tables` and `list_migrations` use the same
  endpoint. Consequence : no tool writes rows one by one today, so
  `supabase.row-write-one` is in the catalog (for a future tool) but no
  preset carries it.
- **`apply_migration` mini-detector.** Always `schema[any].table[any].W`
  (→ `migration-write`) ; plus `row[bulk].W` when a DML keyword
  (`insert|update|delete|merge|truncate|copy`) appears, plus
  `policy[any].W` when a policy or RLS statement appears. False positives
  over-protect.
- **Cascades.** `delete_bucket` emits the bucket write and the bulk object
  write (the objects go with it) ; `deploy_function` with a non-empty
  `files` bundle emits the body write on top of the deployment.
- **Identifiers** (bucket id, path, email, phone, slug, secret name) must
  match `[a-zA-Z0-9_.@+:/~-]+` ; anything else, or a missing required
  identifier, is a denial — never a broad slice.

Removed in v5 : `supabase__service_role_to_venv`, `supabase__anon_key_to_venv`,
`supabase__url_to_venv` (the v4 project env-var store has no v5 counterpart,
plan §8-Q5). `supabase__get_anon_key` still returns the project URL and the
anon key ; `service_role` is fetched gateway-side for the data-plane tools
and never surfaced.

## Catalog

`src/risk-catalog.yaml`, `catalog_version: 1`, 24 named risks + the fallback
`supabase.uncategorized-write` (`supabase.**.W`). The ids are the v4 ids,
unchanged ; a risk is never renamed or deleted, only deprecated.

**Every write risk is env-scoped** (`acceptable_in_envs`) : a mission accepts
`supabase[staging].migration-write`, never a bare `supabase.migration-write`,
and the environment comes from the label the owner put on the project.
The three bulk risks (`bulk-row-write`, `storage.bulk-object-write`,
`auth.bulk-user-write`) are acceptable on `preview` and `staging` only : a
bulk write on a prod project is refused structurally, whatever the policy.
Reads are account-scoped except `auth.read-users` (PII).

The evaluator never drops the fallback : it co-fires on **every** write. A
preset or a policy that allows writes must therefore carry the env-qualified
fallback (`supabase[staging].uncategorized-write`), bounded by its own
quota and gate.

## Presets

| Preset               | Intent                                                                                                        | Writes                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `read-only-analyst`  | Query data and schema, list buckets and objects. No PII user listing.                                         | none                                                                                                           |
| `staging-developer`  | One token per code project : reads everywhere, every write on `staging` projects only.                        | all write risks on `[staging]`, including the fallback ; `gate: auto`                                          |
| `migration-operator` | Schema migrations : free on `staging` ; each prod migration, RLS change or uncategorized prod write is gated. | `[staging]` auto ; `[prod].migration-write`, `[prod].policy-write`, `[prod].uncategorized-write` on `approval` |

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
2. Set the redirect URL to the callback the instance shows on its
   Connections page (it is derived from the instance `public_url`).
3. Pick the scopes the company is ready to grant the gateway. The plugin
   needs `database:read` for the read-only tools, `database:write` for
   migrations, `secrets:read` for the data-plane tools (it reads the
   project `service_role` key through the Management API), and the
   `auth`, `storage`, `edge_functions`, `environment`, `organizations` and
   `projects` scopes for the corresponding tools and for discovery.
4. Enter the **client id** and **client secret** in the instance
   configuration (Admin → Provider apps). The plugin reads them as
   `appConfig.client_id` / `appConfig.client_secret` at refresh time only ;
   nothing else from the environment.

Connecting is then one click : the host runs the authorization-code flow
from the spec above and stores the token pair encrypted. Access tokens live
one hour ; `refresh()` posts `grant_type=refresh_token` with HTTP Basic
client authentication and returns a new secret (the refresh token rotates).
`shouldRefreshSupabaseCredential(secret, now)` says when a proactive refresh
is due (`REFRESH_THRESHOLD_MS` = 60 s before expiry) ; a 401/403 upstream
throws `UpstreamAuthError`, which also triggers a refresh in the host.

### Resource discovery

`discoverResources` lists `GET /v1/organizations` and `GET /v1/projects` and
returns one `Resource` per project : `ref` = project ref, `displayName` =
`<organization> / <project>`, `metadata` = organization, region, status.
The Management API returns the whole list (no paging) ; the plugin caps it
at `MAX_DISCOVERED_PROJECTS` (200) and warns through the logger. The owner
labels each project's `env` on the Connections page.

## Legacy v4 exports

Until P1.6 the v4 application still imports `SupabaseAdapter`,
`supabaseAvailableTools`, `supabaseRiskCatalog`, `supabaseDataModel`,
`classifySupabaseV4`, `supabaseSupportedTools` and `supabaseToolPlanes` from
this package. They are kept, marked `@deprecated`, and implemented on top of
the v5 code (`risk-classifier.ts`, `supabase-adapter.ts`). They are deleted
with the v4 pipeline.

## Tests

`npx vitest run plugins/supabase` — `plugin.test.ts` runs the SDK kit
(`assertPluginWellFormed`, `assertPresetsValid`, `assertNoWildcard`,
`assertCatalogCoverage` with a sample per tool), the credential spec and
refresh against `mockFetch`, `execute` and `discoverResources` against
`mockFetch`, and the presets ; `risk-catalog.test.ts` lints the loaded
catalog ; `risk-classifier.test.ts` and `adapter.test.ts` are the v4 suites,
unchanged. No test ever reaches Supabase.
