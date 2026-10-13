# Provider plugins — the plugin kit

A **provider plugin** teaches the gateway one provider (GitHub, Stripe, a DNS
host…). It is one folder, `plugins/<provider>`, named
`@vaubaan/plugin-<provider>`, and it does six things:

1. describes the provider's **data model** (what exists there);
2. ships a **risk catalog** (`risk-catalog.yaml`): the named risks an agent's
   call can carry, and at least one **preset**;
3. **classifies** each tool call into the part of the data model it touches;
4. declares the **credential**: how a connection to the provider is obtained;
5. **discovers the resources** a connection can reach;
6. **executes** the call with the credential the gateway hands it.

This page is the step-by-step guide to write one, test it and submit it. It
assumes you have never seen the project. Follow the steps in order; each ends
with a command you can run.

- Shipped plugins: `cloudflare-dns`, `github`, `gmail` (experimental),
  `railway`, `resend`, `ssh`, `stripe`, `supabase`, `upstash-redis`, `vercel`.
  Their modelling notes are indexed in
  [`docs/handbook/providers/README.md`](../docs/handbook/providers/README.md).
- The scaffold: [`_template`](./_template/README.md), a complete plugin for an
  imaginary provider.
- The contract: `@vaubaan/plugin-sdk` (`packages/plugin-sdk`), described in
  the handbook [`plugin-sdk`](../docs/handbook/plugin-sdk.md) and decided in
  the ADR
  [`plugin-contract-and-credential-spec`](../docs/decisions/plugin-contract-and-credential-spec.md).
  A plugin imports the SDK and nothing else of the gateway.

## Before you start

Set up the repository as [`CONTRIBUTING.md`](../CONTRIBUTING.md) says
(`npm ci`, then `npm run ci` green). Run `npm run demo` once and issue a
mission in the interface: the risks, presets, resources and environments you
are about to write are what that form shows.

Five words used on every line below:

| Word         | Meaning                                                                                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resource** | One thing a connection reaches at the provider and a mission can be limited to: a repository, a DNS zone, a project. Its owner labels it with an environment (`staging`, `prod`).                                                  |
| **Slice**    | What one call touches, as a path on the data model plus `R` (read) or `W` (write): `acme.workspace[ws-1].widget[w-7].W`. Emitted by your classifier, never shown to a user.                                                        |
| **Risk**     | A named reason a call may be dangerous, with an id that never changes: `acme.widget-write`. It lists the slice patterns it covers (`matches`). When it depends on the environment, its id is qualified: `acme[prod].widget-write`. |
| **Preset**   | A ready-made list of risks with a budget for each, offered when a mission is issued. A shortcut of the form only: the mission stores the explicit list.                                                                            |
| **Mission**  | What an agent works under: a set of resources, and for each accepted risk a quota, a rate limit and a gate (`auto` or `approval`). A call touching a risk the mission did not accept is refused.                                   |

A slice is written `<provider>.<entity>[<id>].<entity>[<id>]….<R|W>`. In a
catalog pattern, `[*]` stands for one segment and `[**]` for any depth;
`[a,b]` is a list. There is no regular expression.

## Step 0 — Propose the plugin

Open a **plugin request** issue
([template](../.github/ISSUE_TEMPLATE/plugin_request.yml)) before writing
code. The risk catalog is the part reviewers argue about; agreeing on the
tools and the dangerous operations first saves a rewrite.

Read the provider's API documentation from its source. Never write a
classifier from memory: a tool that writes while the classifier says it reads
is a security hole.

## Step 1 — Scaffold

Pick the provider id: a lowercase slug (`acme`, `cloudflare-dns`). It is the
folder name, the first segment of every slice and risk id, and the tool
prefix with `-` turned into `_` (`cloudflare_dns__`).

```bash
cp -r plugins/_template plugins/acme
```

Then give the copy its identity. The id is written in **three** places and
derived everywhere else:

| Where                                | Change                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `plugins/acme/package.json`          | `"name": "@vaubaan/plugin-acme"`, the `description`.                                                                  |
| `plugins/acme/src/identity.ts`       | `PROVIDER_ID = 'acme'`.                                                                                               |
| `plugins/acme/src/risk-catalog.yaml` | `provider: acme`, and the `template` prefix of every risk id, pattern and preset entry (`template.` and `template[`). |

Rename the exported symbols too (`templatePlugin` → `acmePlugin`,
`classifyTemplate` → `classifyAcme`, `TEMPLATE_API_BASE` → `ACME_API_BASE`…)
and set `displayName`, `description` and the API base URL. This lists what is
left:

```bash
grep -rniE 'template|widget|example\.com' plugins/acme
```

Link the new workspace and check that the copy still passes:

```bash
npm install                      # links plugins/acme into node_modules, updates package-lock.json
npx vitest run plugins/acme      # the template's tests, under your id
```

`npm install` must be run once after the copy: until then nothing can import
`@vaubaan/plugin-acme`. Commit the `package-lock.json` change it makes.

Never write the provider id or a tool name as a string literal outside
`identity.ts` and the YAML: every other file imports `PROVIDER_ID` and `TOOL`.

## Step 2 — Data model (`src/data-model.ts`)

List the entities a call can touch and how they contain each other. One
**plane** per independent area of the provider (Supabase has `db`, `storage`,
`auth`, `functions`; most providers have one).

```ts
export const acmeDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'workspace',
      description: 'A workspace of the provider and the widgets it holds.',
      entities: [
        {
          name: 'workspace',
          parent: null, // a root entity of the plane
          cardinalities: ['one'],
          description: 'The resource a connection exposes.',
          envScopable: true, // the entity the owner labels staging / prod
        },
        {
          name: 'widget',
          parent: 'workspace',
          cardinalities: ['one', 'unbounded'], // one widget, or all of them
          description: 'A widget inside a workspace.',
        },
      ],
    },
  ],
};
```

- The root entity is normally your **resource**: what `discoverResources`
  returns (step 6) and what a mission selects.
- Mark at most the entities that carry an environment with `envScopable`.
  Leave it out when the provider has no notion of environment (DNS).
- Every slice of the classifier and every `matches` pattern of the catalog
  walks this graph. `definePlugin` validates it at import.

## Step 3 — Risk catalog and presets (`src/risk-catalog.yaml`)

The catalog is the plugin's security statement, and the file reviewers read
first. Write one entry per **intent that deserves its own decision**: not one
per tool, not one per endpoint.

```yaml
provider: acme
catalog_version: 1 # bump on every reviewed change of the content
catalog_date: 2026-10-13

risks:
  - id: acme.read-widgets # never renamed, never deleted: deprecate instead
    label: 'Read widgets'
    reason: 'Why this is a risk, two sentences at most.'
    matches: # one pattern, or a list
      - 'acme.workspace[**].widget[**].R'
    vector:
      reversibility: reversible # reversible | costly | irreversible
      blast: single #             single | env | account | bulk
      data: data #                metadata | data | secret | pii
      cost: free #                free | moderate | unbounded
      visibility: internal #      internal | team | public
      persistence: stateless #    stateless | session | posture

  - id: acme.widget-write
    label: 'Create or modify a widget'
    reason: 'Reversible on staging; visible to customers on prod until reverted.'
    matches: 'acme.workspace[**].widget[**].W'
    acceptable_in_envs: [staging, prod] # makes the risk env-scoped
    vector:
      {
        reversibility: reversible,
        blast: single,
        data: data,
        cost: free,
        visibility: team,
        persistence: session,
      }
    vector_overrides: # optional: what changes in one environment
      prod: { reversibility: costly, visibility: public }

  - id: acme.uncategorized-write # the fallback: mandatory, exactly one
    label: 'Uncategorized write'
    reason: 'Catch-all for writes without a dedicated entry.'
    matches: 'acme.**.W' # must be this catch-all pattern
    fallback: true #       must carry the flag
    vector:
      {
        reversibility: costly,
        blast: env,
        data: data,
        cost: moderate,
        visibility: internal,
        persistence: session,
      }

presets:
  - id: developer
    label: Developer
    description: One line shown in the issuance form.
    entries:
      - risk_id: acme.read-widgets
        quota: 5000 # actions per period, always a number
        rate_limit: { max: 120, window_seconds: 60 }
        gate: auto # auto | approval
      - risk_id: acme[staging].widget-write # env-qualified: the risk is env-scoped
        quota: 500
        rate_limit: { max: 30, window_seconds: 60 }
        gate: auto
      - risk_id: acme[prod].widget-write
        quota: 20
        rate_limit: { max: 5, window_seconds: 60 }
        gate: approval
```

Rules, all enforced when the file is loaded (at gateway boot and in tests):

- **Ids.** `<provider>.<name>`, lowercase with dashes. An id is never renamed
  and never deleted, because missions store it: mark the entry
  `deprecated: true` with `replaced_by: <id>` instead.
- **Reads need an entry too.** A slice no entry matches is refused at
  runtime, and the fallback only catches writes.
- **The fallback.** Exactly one entry named `<provider>.uncategorized-…`,
  matching `<provider>.**.W`, flagged `fallback: true`. It is touched only by
  a write no other entry covers. Seeing it in an audit log means the catalog
  misses an entry; a preset may not contain it
  ([ADR](../docs/decisions/fallback-risk-only-when-uncategorized.md)).
- **Environment.** A risk whose severity depends on the environment is
  **one** entry with `acceptable_in_envs`, never two ids with the environment
  in the name. In a mission and in a preset it appears qualified,
  `acme[prod].widget-write`. A call on a resource its owner has not labelled
  cannot touch an env-scoped risk: it is refused.
- **Presets.** At least one. Every entry names one explicit risk id of this
  catalog, with a numeric `quota`, a `rate_limit` and a `gate`. **Never a
  wildcard, never "all"**: a preset that allows everything lists everything.
  No deprecated risk, no risk twice, an env-qualified id only for an
  env-scoped risk and one of its environments. Offer at least a read-only
  preset and one for daily work; put `gate: approval` on what you would want
  to be asked about.
- **Limits.** The only limit the gateway enforces is
  `infra_limits.calls_per_minute_max` on a risk: the ceiling of the rate
  limit a mission can be issued with. Do not declare `caps` or another
  `infra_limits` key
  ([ADR](../docs/decisions/scope-caps-not-enforced-in-v5-0.md)); a limit the
  provider needs is refused by your classifier.
- Unknown keys are refused, so a typo never silently disables a rule.

Check the file alone, before writing the classifier:

```bash
npx vitest run plugins/acme -t 'well-formed'
```

A failure lists every problem with its path
(`presets[0].entries[2].risk_id 'acme.nope' is not a risk of the 'acme' catalog`).

## Step 4 — Tools and classifier (`src/tools.ts`, `src/classify.ts`)

**Tools.** Declare the tool names once in `identity.ts` (`TOOL`), built with
`toolPrefixFor(PROVIDER_ID)` as `<prefix><verb>_<noun>`; `tools.ts` gives each
a description and a JSON input schema. Every tool that acts on a resource
takes the resource ref as an explicit argument.

**Classifier.** `classify(tool, args, resources)` returns
`{ slices: Slice[] }` or `{ denied: string }`. `resources` are the mission's
resources on this connection. This is the security-critical file: the gateway
decides from the slices alone, so a slice that understates a call lets the
call through.

```ts
case TOOL.updateWidget: {
  const id = pathIdent(args.widget_id);
  if (!id) return { denied: MALFORMED_WIDGET_ID };
  return { slices: [parseSlice(`${PROVIDER_ID}.workspace[${ws}].widget[${id}].W`)] };
}
```

The rules the template already applies and a plugin must keep:

- **Pure.** No network, no credential, no clock. Same input, same output.
- **Fail closed.** An unknown tool, a missing or malformed argument, a
  resource that is ambiguous: `{ denied }`. Never a broader slice "to be
  safe", never a default.
- **The classifier checks the resource.** An explicit resource ref must be
  one of `resources`; otherwise the call is refused. Never substitute the
  mission's single resource for a ref the caller named
  (`resolveWorkspace` in the template). An absent ref may fall back to the
  single resource; none or several is refused.
- **Validate every identifier** before it enters a slice. One that will also
  reach a URL path must be a single path segment
  (`pathIdent`, `^[A-Za-z0-9_-]{1,64}$`): `..` survives `encodeURIComponent`
  and would redirect the request away from what the slice named.
- **Say everything the call does.** A call touching several entities returns
  several slices. A tool whose effect depends on an argument (a SQL
  statement, a shell command, a `force` flag) is classified from that
  argument, and refused when it cannot be read. A call that hands out a
  credential (a token, a signed URL) is a write.
- **One function for both sides.** Export what resolves the target and call
  it from `execute` too, so the call runs on exactly what was classified.

## Step 5 — Credential (`credential` in `src/index.ts`)

You declare **how** a connection is obtained; the gateway runs the flow,
stores the result encrypted and hands the decrypted secret to `execute` for
the duration of one call. A plugin writes no route, never reads the
environment and never sees an OAuth client secret. One `CredentialSpec` per
plugin, of one of four kinds:

| Kind          | When                                         | You declare                                                                                                | `execute` receives                                           |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `api-key`     | The user pastes a key or token.              | `fields` (at least one `secret: true`), `createUrl?`                                                       | `{ fields, metadata }`                                       |
| `oauth2`      | The user consents on the provider's page.    | `authorizationUrl`, `tokenUrl`, `scopes`, `pkce`, `clientAuthMethod`, `refreshable`, `resourceIndicator?`… | `{ accessToken, refreshToken, expiresAt, scopes, metadata }` |
| `app-install` | The company installs an app (GitHub App).    | `appConfigFields`, `installUrl(appConfig)`, `installationIdParam`, `userVerification`                      | `{ installationId, metadata }`, plus `ctx.appConfig`         |
| `ssh-key`     | The gateway generates a key pair for a host. | `algorithm: 'ed25519'`, `fields` (host, port, user)                                                        | `{ privateKeyPem, publicKey, fields, metadata }`             |

**`api-key`** (the template):

```ts
credential: {
  kind: 'api-key',
  createUrl: 'https://acme.example/settings/api-keys', // where the user creates the key
  fields: [
    {
      name: API_KEY_FIELD, // read back in execute.ts through the same constant
      label: 'API key',
      secret: true, // masked in the form, never logged
      required: true,
      pattern: '^[A-Za-z0-9_-]{8,}$', // checked by the gateway before any call
      help: 'Create a key limited to the workspaces the agent may touch.',
    },
  ],
},
```

In `help`, tell the user the narrowest key that works. The gateway restricts
what an agent does with the key; it cannot restrict the key itself.

**`oauth2`.** Each company registers its own OAuth app at the provider; the
operator enters its client id and secret in Admin → Provider apps (the
gateway always asks for those two; list anything else you need in
`appConfigFields`). Set `refreshable: true` when the token endpoint issues
refresh tokens: the gateway performs the standard `refresh_token` grant
itself. Write `refresh()` on the plugin only when the provider's refresh is
not the standard one.

**`app-install` and `userVerification`.** After the installation the provider
redirects the browser back with an installation id. That id is a claim made
by a browser: without a check, a user could connect an installation that
belongs to somebody else. `userVerification` tells the gateway how to check
it. It is data, you run none of it:

```ts
userVerification: {
  codeParam: 'code', //                 callback parameter carrying the authorization code
  tokenUrl: 'https://github.com/login/oauth/access_token',
  clientAuthMethod: 'client_secret_post', // or 'client_secret_basic'
  installationsUrl: 'https://api.github.com/user/installations', // what the user can reach
  installationsHeaders: { accept: 'application/vnd.github+json' }, // never Authorization
  installationsListField: 'installations', // omit when the body is the list
  installationIdField: 'id',
  pagination: { pageParam: 'page', perPageParam: 'per_page', perPage: 100 }, // omit if unpaged
},
```

The gateway exchanges the code for a user token, lists the installations that
token reaches, accepts the installation id only when it is in the list, and
drops the token. For this to work the provider's app must ask the installing
user to authorize it (GitHub: "Request user authorization (OAuth) during
installation"), and `appConfigFields` must list `CLIENT_ID_FIELD` and a
secret `CLIENT_SECRET_FIELD` (both exported by the SDK). **Declare the block
whenever the provider offers such a list**: a spec without it is refused by
the gateway unless the operator explicitly accepts unverified installations.
The worked example is
[`plugins/github/src/credential.ts`](./github/src/credential.ts).

A plugin whose provider takes an app (`oauth2`, `app-install`) must also show
its settings in the two deployment examples, `deploy/config/gateway.example.yaml`
and `deploy/config/.env.example`; a structural test compares them with the
`appConfigFields` of the registered plugins (step 10).

## Step 6 — Resources (`discoverResources` in `src/execute.ts`)

`discoverResources(ctx)` runs when the connection is created and when its
owner refreshes it. It returns what the credential reaches:

```ts
return workspaces.map((w) => ({ provider: PROVIDER_ID, ref: w.id, displayName: w.name }));
```

- `ref` is the identifier your tools take as their resource argument, and the
  one your classifier compares with. Use the provider's stable id, not a name
  that can be changed.
- `metadata` (optional, strings) carries non-secret facts the classifier
  needs later, such as an account id or a zone name.
- Do not set `env` unless the provider itself tells production from test
  (Stripe's live and test modes): the environment is the owner's label.
- **The provider's answer is untrusted.** Check it with a type guard, never
  cast it; refuse a payload you do not recognise.
- Follow the provider's pagination, with a ceiling you state.

## Step 7 — Execution (`execute` in `src/execute.ts`), and streaming

`execute(ctx, tool, args)` performs the call and returns an `McpToolResult`.
It runs only after the gateway allowed the call and counted it.

- Use **`ctx.fetch`**, never the global `fetch`: tests inject a mock, the
  gateway its own.
- Take the secret with `expectCredentialKind(PROVIDER_ID, ctx.credential, '<kind>')`.
  Never log it, never put it in a result or an error message.
- Resolve the target with the **classifier's functions** (step 4).
- **A provider failure is thrown, never returned**:
  `UpstreamAuthError(message, status)` on 401 or 403,
  `UpstreamHttpError(message, status)` on any other failed status; a network
  error is left to propagate. The gateway records it and still tells the
  agent. Raise 401 only when the provider says the credential itself is
  invalid: the gateway then tries a refresh and otherwise marks the
  connection expired.
- **`isError: true` is for what your executor declines itself**, before any
  request: an unknown tool, an argument it cannot read, a target outside the
  mission. Never catch a provider failure into an `isError` result: the audit
  would say the call went through.
- The provider's base URL is a constant of the plugin: it is a fact about the
  provider, not configuration of the instance.

The full table is in the SDK handbook,
["Errors of `execute`"](../docs/handbook/plugin-sdk.md#errors-of-execute).

**Optional: streamed results (`ctx.emitPart`).** For a tool whose provider
answers progressively (logs, a long export). `execute` still returns the
complete result; each part handed to `emitPart` also leaves for the caller at
once.

```ts
import { streamToolResult, textParts } from '@vaubaan/plugin-sdk';

const response = await ctx.fetch(url, { headers }); // open the response first
if (response.status === 401) throw new UpstreamAuthError('…', 401);
if (!response.ok || !response.body) throw new UpstreamHttpError('…', response.status);
return streamToolResult(ctx, textParts(response.body));
```

Open the provider's response before the first part, let `streamToolResult`
await every part, and throw when the provider's stream breaks. A plugin that
never streams ignores `emitPart`; no shipped plugin uses it yet
(handbook, ["Streamed results"](../docs/handbook/plugin-sdk.md#streamed-results-streamingts)).

**Environment in the call.** When the environment is part of the call rather
than a label on the resource (Vercel's `env[prod]` segment), declare
`envOf: envFromSliceSegment('env')` in `definePlugin`, or a pure function of
your own. Otherwise declare nothing.

## Step 8 — Wire and test (`src/index.ts`, `tests/unit/`)

`src/index.ts` assembles the plugin and exports it as the default export:

```ts
export const acmeCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const acmePlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Acme',
  version: '0.1.0', // equal to the version in package.json
  tools: acmeTools,
  dataModel: acmeDataModel,
  catalog: acmeCatalog.catalog,
  credential: { … },
  classify: classifyAcme,
  execute: executeAcme,
  discoverResources: discoverAcmeResources,
});

export default acmePlugin;
```

Load the catalog with `catalogPathNextTo(import.meta.url)` exactly as above.
Never `new URL('./risk-catalog.yaml', import.meta.url)`: the application's
bundler rewrites that expression and the build fails
([ADR](../docs/decisions/plugin-catalog-path-and-standalone-tracing.md)).
`definePlugin` validates the whole definition at import and reports every
problem at once.

**The SDK test kit is mandatory.** Keep `tests/unit/plugin.test.ts` from the
template and make it yours:

```ts
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
  mockFetch,
} from '@vaubaan/plugin-sdk/testing';

assertPluginWellFormed(acmePlugin); // the definition and the catalog, fallback flag included
assertPresetsValid(acmePlugin); //     presets: explicit risks of this catalog, legal budgets
assertNoWildcard(acmePlugin); //       no `*` or `?` in a risk id or a preset entry
const report = assertCatalogCoverage(
  acmePlugin,
  {
    [TOOL.listWidgets]: [{ args: { workspace: 'ws-stg' } }],
    [TOOL.updateWidget]: [
      { args: { workspace: 'ws-stg', widget_id: 'w1', name: 'x' } },
      { args: { workspace: 'ws-other', widget_id: 'w1', name: 'x' }, expectDenied: true },
    ],
    // … at least one realistic sample for every declared tool
  },
  { resources: [staging] }, // the mission's resources, for samples that give none
);
expect(report.fallbackHits).toEqual([]); //  no realistic call lands on the fallback
expect(report.risksUntouched).toEqual([]); // or the entries you knowingly leave unreached
```

`assertCatalogCoverage` fails when a tool has no sample, when a sample is
refused without `expectDenied` (or the reverse), and when a slice matches no
risk of the catalog. `fallbackHits` lists the samples only the fallback
covered: add the missing catalog entry.

Then write, in the same folder:

- **Classifier tests: one case per branch of `classify.ts`**, every refusal
  included (unknown tool, resource outside the mission, ambiguous resource,
  malformed identifier, `..`). Build the cases from the provider's public
  documentation or recorded answers. This is where review time goes.
- **`execute` and `discoverResources` against `mockFetch([...routes])`**: the
  request sent (method, URL, headers, body), the two thrown failures, the
  `isError` refusals with no request sent, a payload discovery must refuse.
  An unmatched request fails the test.

**No test ever calls a real provider**, and none needs a credential.

```bash
npx vitest run plugins/acme        # the plugin alone (a plugin has no `test` script)
npm run type-check                 # every workspace, yours included
npx eslint plugins/acme --max-warnings=0
npx prettier --check plugins/acme  # `npx prettier --write plugins/acme` fixes it
```

## Step 9 — README and handbook

Two documents, both in English, both in the same pull request as the code.

**`plugins/<id>/README.md`** — for somebody who will use the plugin. Replace
the template's README, keeping its sections: Data model, Credential and
resources, Tools, Catalog (one line per risk), Presets, Tests.

**`docs/handbook/providers/<id>.md`** — for the reviewer and the next
maintainer: the model and the reasons behind it. Start it with this
frontmatter and write the six sections every provider handbook has:

```markdown
---
title: Acme provider plugin
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - plugins/acme/src/
  - plugins/acme/tests/unit/
---

# Acme provider plugin

## 1. Data model

## 2. Tool → slice mapping

## 3. Catalog and presets

## 4. Coverage

## 5. Edge cases

## 6. Credential, discovery, execution, tests
```

"Coverage" is a table showing that every tool is covered by a named risk, not
by the fallback. "Edge cases" argues each classification that is not obvious:
it is the section a security reviewer reads. `tracks:` lists the files the
handbook describes; the project's drift check compares the two.

Add your plugin's row to the index table in
[`docs/handbook/providers/README.md`](../docs/handbook/providers/README.md),
and set `docsUrl` in `definePlugin` to the handbook's URL.

## Step 10 — Register the plugin

A plugin under `plugins/` is tested by `npm run ci` but is not part of the
gateway until it is registered. One list holds the providers; everything else
(the connect page, Admin → Provider apps, the tool list) derives from it.

1. `apps/gateway/package.json`: add `"@vaubaan/plugin-acme": "*"` to
   `dependencies`, then run `npm install`.
2. `apps/gateway/src/server/compose/shipped-plugins.ts`: one import of the
   default export, one entry in `SHIPPED_PLUGINS`.
3. For an `oauth2` or `app-install` plugin: its app settings in
   `deploy/config/gateway.example.yaml` and `deploy/config/.env.example`.

Add the provider to no other list; if a test or a page needs the provider
list, it reads the registry. Set `experimental: true` in `definePlugin` for a
plugin the gateway should register but keep out of the default connect and
issuance flows until it is proven.

```bash
npm run ci                         # type-check, lint, format check, build, tests
```

## Step 11 — Version, changelog, pull request

**Plugin version** — `version` in `src/index.ts` and in the plugin's
`package.json`, always equal (after changing it: `npm install`, which updates
`package-lock.json`). A new plugin starts at `0.1.0`. It is what telemetry
reports, so one version never designates two different classifiers.

| Change                                                                                                                   | From `1.0.0` | Before `1.0.0`        |
| ------------------------------------------------------------------------------------------------------------------------ | ------------ | --------------------- |
| A fix that changes no tool, risk or preset                                                                               | patch        | patch                 |
| A new tool, risk or preset; a widened pattern                                                                            | minor        | patch                 |
| A removed tool; a stricter classification (calls once allowed are refused); a change of what `execute` throws or returns | major        | minor (`0.2` → `0.3`) |

**Catalog version** — `catalog_version` in the YAML, an integer, independent
of the plugin version. Bump it and set `catalog_date` on every reviewed
change of the catalog's content: an entry, a pattern, a vector, a limit, a
preset, a label, a reason. Not for a YAML comment.

**Changelog** — one entry in the root [`CHANGELOG.md`](../CHANGELOG.md) under
`[Unreleased]`, naming the plugin and its version. Plugins have no changelog
of their own.

**Pull request** — one plugin per pull request, with the
[template checklist](../.github/PULL_REQUEST_TEMPLATE.md) answered. In the
description, link the plugin request issue and state which provider
documentation the classifier was written from. Expect the review to
concentrate on the catalog, the classifier's refusals and the handbook's
"Edge cases".

Plugins live in this repository and are not published to npm for now
([layout ADR](../docs/decisions/repository-layout-and-contribution-workflow.md)).

## Changing an existing plugin or its catalog

To report a wrong or missing risk without writing the fix, use the **catalog
correction** issue
([template](../.github/ISSUE_TEMPLATE/catalog_correction.yml)). To make the
change yourself:

- **A call is classified too leniently, or a risk is missing**: fix the
  classifier or add the entry, add the test that would have caught it, update
  the handbook's mapping and edge cases, bump `catalog_version` and the
  plugin version (a stricter classification is a breaking step). If the gap
  lets a mission do more than it accepted, report it privately first:
  [`SECURITY.md`](../SECURITY.md).
- **A vector, a label or a reason is wrong**: change the entry, bump
  `catalog_version`, say why in the pull request.
- **A risk must go**: never delete or rename it. `deprecated: true`, with
  `replaced_by` when a successor exists; remove it from the presets.
- **Preset values** (quotas, rate limits, gates) are a starting point chosen
  by the plugin's author. Propose a change with the usage that motivates it.

## When something fails

| Message                                                                 | Cause and fix                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Cannot find package '@vaubaan/plugin-<id>'`                            | The workspace is not linked: run `npm install` at the root.                                                         |
| `Invalid risk catalog '…'` followed by bullets                          | Read every bullet; each path is exact (`risks[3].vector.blast`, `presets[1].entries[2].risk_id`).                   |
| `exactly one fallback entry per catalog, found 2`                       | A second entry matches `<id>.**.W` or carries the flag: give it a narrower pattern.                                 |
| `… is the fallback — a preset must not pre-accept uncategorized writes` | Remove the fallback from the preset; the writes you meant are covered by their own entries.                         |
| `PluginDefinitionError … must start with '<prefix>'`                    | A tool name was written by hand: build it in `identity.ts` with `toolPrefixFor`.                                    |
| `assertCatalogCoverage … no catalog risk matches it`                    | The classifier emits a slice outside every `matches`. A read needs its own entry: the fallback only catches writes. |
| `report.fallbackHits` is not empty                                      | A realistic call is covered by the fallback alone: add the catalog entry.                                           |
| `mockFetch: unexpected GET …`                                           | The plugin requested a URL no route covers: add the route or fix the URL.                                           |
| `next build` fails reading `risk-catalog.yaml`                          | The catalog is loaded with `new URL(…, import.meta.url)`: use `catalogPathNextTo(import.meta.url)`.                 |
| `example-config-providers.test.ts` fails                                | An `oauth2` or `app-install` plugin is registered without its settings in `deploy/config/*.example*` (step 10).     |

More cases: SDK handbook,
["How to debug"](../docs/handbook/plugin-sdk.md#how-to-debug).

## Working with a coding agent

[`docs/skills/provider-modeler.md`](../docs/skills/provider-modeler.md) is the
same process written as instructions for a coding agent: it stops for a human
review of the model before any code is written.
