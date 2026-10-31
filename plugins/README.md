# Provider plugins — the plugin kit

A **provider plugin** teaches the gateway one provider (GitHub, Stripe, a DNS
host…). It is one folder, `plugins/<provider>`, named
`@vaubaan/plugin-<provider>`, and it does six things:

1. describes the provider's **data model** (what exists there);
2. ships a **risk catalog** (`risk-catalog.yaml`): the named risks an agent's
   call can carry, grouped into **macro-actions**;
3. **classifies** each tool call into the part of the data model it touches;
4. declares the **credential**: how a connection to the provider is obtained;
5. **discovers the resources** a connection can reach;
6. **executes** the call with the credential the gateway hands it.

This page is the step-by-step guide to write one, test it and submit it. It
assumes you have never seen the project. Follow the steps in order. Steps 1, 3, 8 and 10
end with a command that checks your work; between steps 4 and 8 the copied
tests are broken on purpose, and `npx tsc -p plugins/<id> --noEmit` is the
check to run after each file.

- Shipped plugins: every folder of `plugins/` but `_template`, registered in
  [`shipped-plugins.ts`](../apps/gateway/src/server/compose/shipped-plugins.ts).
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
(`npm ci`, then `npm run ci` green). Run `npm run demo` once, create a mission in the interface (Missions → New
mission) and open Reference: the risks, macro-actions, resources and environments
you are about to write are what those pages show.

Five words used on every line below:

| Word             | Meaning                                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resource**     | One thing a connection reaches at the provider and a mission can be limited to: a repository, a DNS zone, a project. Its owner labels it with an environment (`staging`, `prod`).                                                                  |
| **Slice**        | What one call touches, as a path on the data model plus `R` (read) or `W` (write): `acme.workspace[ws-1].widget[w-7].W`. Emitted by your classifier, never shown to a user.                                                                        |
| **Risk**         | A named reason a call may be dangerous, with an id that never changes: `acme.widget-write`. It lists the slice patterns it covers (`matches`). When it depends on the environment, its id is qualified: `acme[prod].widget-write`.                 |
| **Macro-action** | One thing to do with the provider, in its words ("Read", "Ship"): a group of risks, each with a base budget. A creator ticks it at a trust level (Careful, Trusting, Autonomous), which writes the explicit lines; the mission stores those lines. |
| **Mission**      | What an agent works under: a set of resources, and for each accepted risk a quota, a rate limit and a gate (`auto` or `approval`). A call touching a risk the mission did not accept is refused.                                                   |

The interface shows these to people under other words: a provider is a
**service**, a connection an **account**, a risk a **permission**, a gate
**runs freely** (`auto`) or **ask me first** (`approval`), a quota and a rate
limit **limits**. The contract — this guide, the YAML, the SDK — keeps the
names above.

A slice is written `<provider>.<entity>[<id>].<entity>[<id>]….<R|W>`:

| Form                                        | Meaning                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `acme.workspace[ws-1].widget[w-7].W`        | A write on one widget.                                                                |
| `acme.workspace[ws-1].widget[*].R`          | A read of every widget of the workspace (a list). The entity is declared `unbounded`. |
| `acme.workspace[ws-1].widget.W`             | A write on the collection, without an id: a creation.                                 |
| `acme.workspace[ws-1].widget[w-7].delete.W` | A **verb leaf**: an operation that deserves its own risk among the writes (step 2).   |

In a catalog pattern, `[*]` stands for one identifier and `[**]` for any
identifier and anything below it; `[a,b]` is a list. There is no regular
expression. A slice can match the patterns of **several risks**: it then
touches all of them, and the mission must have accepted every one. One
counter is decremented per risk, and if any of them is gated `approval` the
whole call waits for the approval.

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

Then give the copy its identity. Inside the plugin folder the id is written
in **three** places and derived everywhere else:

| Where                                | Change                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `plugins/acme/package.json`          | `"name": "@vaubaan/plugin-acme"`, the `description`.                                                                        |
| `plugins/acme/src/identity.ts`       | `PROVIDER_ID = 'acme'`.                                                                                                     |
| `plugins/acme/src/icon.ts`           | The service's mark: a Simple Icons path (CC0 1.0; name the slug in the comment) or one drawn by hand on the 24 grid.        |
| `plugins/acme/src/risk-catalog.yaml` | `provider: acme`, and the `template` prefix of every risk id, pattern and macro-action entry (`template.` and `template[`). |

Rename the exported symbols too (`templatePlugin` → `acmePlugin`,
`classifyTemplate` → `classifyAcme`, `TEMPLATE_API_BASE` → `ACME_API_BASE`…)
and set `displayName`, `description`, `summary` (the paragraph the interface shows on the provider's page under Reference,
in the interface's words: what one account is, what one resource is, where
the environment comes from), `icon` (the `d` of one SVG path on a 24×24 grid,
shown monochrome beside the name wherever the interface marks the service —
`require('simple-icons').si<Name>.path` is the usual source, CC0 1.0; vendor
the string in `src/icon.ts` with a comment naming the slug, never a runtime
dependency on the package; the structural test `plugin-icons.test.ts` holds
every shipped plugin to declaring one) and the API base URL. **Change nothing
else yet**: the workspaces and widgets of the imaginary provider stay until
you replace them file by file in steps 2 to 8. This lists what is left of
the scaffold; it must print nothing by the end of step 9:

```bash
grep -rniE 'template|widget|example\.com' plugins/acme
```

Link the new workspace and check that the copy still passes:

```bash
npm install                      # links plugins/acme into node_modules, updates package-lock.json
npx vitest run plugins/acme      # the template's tests, under your id
```

`npm install` must be run once after the copy: until then nothing can import
`@vaubaan/plugin-acme`. Commit the `package-lock.json` change it makes (a few
lines naming your plugin). It also prints an audit summary of the existing
dependencies; ignore it, and do not run `npm audit fix`, which would rewrite
the lockfile.

In the code, never write the provider id or a tool name as a string literal
outside `identity.ts` and the YAML: every other file imports `PROVIDER_ID`
and `TOOL`. (The id also appears, later, in your two documents and in the
registration of step 10.)

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
- `cardinalities` says how a slice may name the entity: `one` (a single
  identifier, or no identifier), `bounded` (an explicit list `[a,b]`),
  `unbounded` (`[*]`, all of them).
- **Verb leaves.** A slice ends in `R` or `W` and nothing else. To give an
  operation its own risk among the writes — a deletion, a publication, a
  transfer — declare a leaf entity under the entity it acts on
  (`{ name: 'delete', parent: 'widget', cardinalities: ['one'] }`), emit
  `…widget[<id>].delete.W` from the classifier, and match it in the catalog.
  The template does this for `delete_widget`.
- Mark at most the entities that carry an environment with `envScopable`.
  Leave it out when the provider has no notion of environment (DNS).
- Every slice of the classifier and every `matches` pattern of the catalog
  must use these entities, in this order. `definePlugin` checks that the
  model is consistent (every `parent` exists); **nothing checks your slices
  and patterns against it**. A slice naming an entity you did not declare is
  accepted and falls to the fallback, so the model is what the reviewer
  compares your classifier with.

```bash
npx tsc -p plugins/acme --noEmit   # the check to run after each file of steps 2 to 7
```

## Step 3 — Risk catalog and macro-actions (`src/risk-catalog.yaml`)

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

  - id: acme.widget-delete # its own decision, through the verb leaf of step 2
    label: 'Delete a widget'
    reason: 'A deleted widget cannot be restored.'
    matches: 'acme.workspace[**].widget[**].delete.W'
    acceptable_in_envs: [staging, prod]
    vector:
      {
        reversibility: irreversible,
        blast: single,
        data: data,
        cost: free,
        visibility: team,
        persistence: session,
      }

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

macro_actions:
  - id: read
    label: Read
    description: One line shown under the macro-action in New mission.
    entries:
      - risk_id: acme.read-widgets # unqualified, never the fallback
        quota: 500 # the base budget a trust level multiplies (×1, ×3, ×10)
        rate_limit: { max: 60, window_seconds: 60 }
  - id: change
    label: Change widgets
    description: Create, modify and delete widgets.
    entries:
      - risk_id: acme.widget-write
        quota: 100
        rate_limit: { max: 20, window_seconds: 60 }
      - risk_id: acme.widget-delete
        quota: 10
        rate_limit: { max: 2, window_seconds: 60 }
```

Rules, all enforced when the file is loaded (at gateway boot and in tests):

- **Ids.** `<provider>.<name>`, lowercase with dashes. An id is never renamed
  and never deleted, because missions store it: mark the entry
  `deprecated: true` with `replaced_by: <id>` instead.
- **Words people read.** `label`, `reason` and a macro-action's `description` are
  shown verbatim in Reference and in the dialogs of a mission, where a risk
  is called a permission, a gate "runs freely" or "ask me first", and a
  budget "limits". A sentence that addresses the reader about the product
  uses those words ("a mission must hold this permission too", "production
  writes ask first"); a sentence that describes the provider keeps the
  provider's. Ids, keys and structure keep the contract's names.
- **Overlapping patterns add up.** `widget[**].W` also matches
  `widget[w-7].delete.W`, so a deletion touches `widget-write` **and**
  `widget-delete`: a mission needs both, and one of them gated `approval` is
  enough for the call to wait. This is how the shipped catalogs layer risks
  ("any write" plus "a dangerous write"). When you want two risks that do not
  add up, give them patterns that do not overlap. The template's test shows
  how to assert which risks a slice touches.
- **Reads need an entry too.** A slice no entry matches is refused at
  runtime, and the fallback only catches writes.
- **The fallback.** Exactly one entry named `<provider>.uncategorized-…`,
  matching `<provider>.**.W`, flagged `fallback: true`. It is touched only by
  a write no other entry covers. Seeing it in an audit log means the catalog
  misses an entry; no macro-action may contain it
  ([ADR](../docs/decisions/fallback-risk-only-when-uncategorized.md)).
- **Environment.** A risk whose severity depends on the environment is
  **one** entry with `acceptable_in_envs`, never two ids with the environment
  in the name. In a mission it appears qualified,
  `acme[prod].widget-write`. A call on a resource its owner has not labelled
  cannot touch an env-scoped risk: it is refused.
- **Macro-actions.** 3 to 6, named in the provider's words ("Read", "Ship",
  "Move money out"), independent of each other: every entry but the fallback
  and deprecated ones belongs to **exactly one**, unqualified, with a base
  budget and no gate. A creator ticks them at a trust level; the gate follows
  the entry's vector (irreversible asks or stays out, costly asks, a
  sensitive read asks at the lowest trust level), so the vector must be right. The
  gateway adds "Anything else" for the fallback
  ([ADR](../docs/decisions/macro-actions-and-trust-levels-prefill-the-policy.md)).
- **No presets.** Presets were retired: a catalog with a `presets` key does
  not load ([ADR](../docs/decisions/macro-actions-and-trust-levels-prefill-the-policy.md)).
  A risk whose tool hands the agent a token that can write
  (`tokenHandouts`) asks first at every trust level.
- **Limits.** The only limit the gateway enforces is
  `infra_limits.calls_per_minute_max` on a risk: the ceiling of the rate
  limit a mission can be issued with. Do not declare `caps` or another
  `infra_limits` key
  ([ADR](../docs/decisions/scope-caps-amplification-axis.md)); a limit the
  provider needs is refused by your classifier.
- Unknown keys are refused, so a typo never silently disables a rule.

Check the file alone, before writing the classifier (the filter is the title
of the first test of the template; keep that title):

```bash
npx vitest run plugins/acme -t 'well-formed'
```

A failure lists every problem with its path
(`macro_actions[0].entries[2].risk_id 'acme.nope' is not an unqualified risk of the 'acme' catalog`).
This checks the catalog against its own rules only. Whether it covers what
your tools really do is checked in step 8, by `assertCatalogCoverage`.

## Step 4 — Tools and classifier (`src/tools.ts`, `src/classify.ts`)

**Tools.** Declare the tool names once in `identity.ts` (`TOOL`), built with
`toolPrefixFor(PROVIDER_ID)` as `<prefix><verb>_<noun>`; `tools.ts` gives each
a description and a JSON input schema. Every tool that acts on a resource
takes the resource's `ref` (the identifier `discoverResources` returns,
step 6) as an explicit argument. The one exception is a rewrapped upstream
tool whose frozen schema has no resource argument: it is acceptable only
when a connection has exactly one resource, so the classifier resolves the
mission's single resource and refuses none or several, and the plugin's
handbook argues why (`context7`). The `properties` of the schema are the
whole argument surface of the tool: an argument is declared there before
the classifier or the executor may use it (see "Only declared arguments"
below).

**Say what each tool does in a few words** (`toolTitles`, keyed by tool name:
`templateToolTitles` in the template's `tools.ts`, a `tool-titles.ts` of its
own in the larger plugins). When a call asks a person first, the interface
heads the request with the title and the resource the call resolves to —
"Delete a widget · acme-staging" — so that the person reads what the agent
wants to do rather than the name of a permission. A verb and its object,
sentence case, no final period, 60 characters at most (`definePlugin` checks
it). It is for people only: `tools/list` does not carry it, the description
stays what an agent reads. Optional in the contract; a tool without a title
is headed by its name, and every tool of a plugin shipped with the gateway
has one.

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
- **Identifiers: one grammar function per kind, shared by `classify` and
  `execute`; refuse, never repair**
  ([ADR](../docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)).
  Every identifier a call carries — an argument, a resource ref, connection
  metadata, a value the provider answered — is read by the grammar function
  of its kind, which returns the value or `null` (`pathIdent` in the
  template). A value outside its grammar is `denied` here and refused in
  `execute` before any request: it is never trimmed, escaped, replaced or
  read as absent.
- **Choose the grammar for where the value lands**, not for the slice. A URL
  path segment: `pathIdent`, `^[A-Za-z0-9_-]{1,64}$` — no dot-only value, no
  separator, no `%` (`..` survives `encodeURIComponent`, and the URL parser
  then removes it: the request would leave what the slice named). A value
  that is legitimately dotted or multi-segment (a domain, a file path, a git
  ref, a bucket name) gets a grammar of its own that forbids empty and
  dot-only segments, backslashes and control characters, and bounds the
  length. A query is built with `URLSearchParams`; a GraphQL value is a
  variable, never part of the document; an SQL identifier has a closed
  grammar, no quoting; a string the provider could split (a recipient) is
  one value.
- **An identifier the slice grammar cannot carry is written as "any".** A
  slice identifier holds `[a-zA-Z0-9_./~-]` only, and your grammar may
  rightly accept more (`@` in an address, `:` in a secret name, `+`). Build
  the segment with `identSegment(value)` of the SDK: it returns the
  identifier when the slice can carry it and `ANY_IDENT` (`[*]`) otherwise.
  The call is then classified on every instance of the entity, so only a
  mission whose pattern covers them all accepts it. Never drop the
  identifier (the slice would match a narrower pattern than the call
  deserves) and never escape it (the slice would no longer be the name an
  owner writes). The value sent to the provider is unchanged.
- **No glob inside an executed identifier.** A slice your classifier emits
  names what the call touches: a `*` inside an identifier (`feature/*`), or
  in a value of a list, is read by the matcher as a pattern, and the gateway
  refuses the call. Refuse such a value in its grammar. The whole-segment
  `[*]` (`ANY_IDENT`) is the only way to say "every instance".
- **Say everything the call does.** A call touching several entities returns
  several slices. A tool whose effect depends on an argument (a SQL
  statement, a shell command, a `force` flag) is classified from that
  argument, and refused when it cannot be read. A call that hands out a
  credential (a token, a signed URL) is a write.
- **One reader for both sides.** Export the function that reads the
  identifiers of a call (the target and every other one) and call it from
  `execute` too: `execute` builds its request from what that function
  returned, never from `args`, and is safe when called alone.
- **Only declared arguments.** An argument the classifier does not read was
  priced by no rule. Whether you must refuse it depends on how `execute`
  builds its request
  ([ADR](../docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)):
  - `execute` **forwards the arguments it was given** — a JSON body or a
    query string built from `args`, a rewrapped upstream tool that receives
    them whole: an undeclared argument would reach the provider unseen. Call
    `undeclaredArgumentDenial(declared, tool, args, routing?)` of the SDK
    **in `classify` and in `execute`**, with
    `declared = declaredArgumentsOf(tools)` built once. In `classify` the
    answer is a denial, so the call is refused before the budget and audited
    as a refusal; in `execute` it is the second lock, for a caller that did
    not go through `classify` (decline with the same sentence, step 7).
    Export one function of your own that wraps the call, so both sides
    apply the same rule.
  - `execute` **builds its request field by field** from the declared
    arguments, as the template does (`{ name: args.name }`): it never reads
    another argument, and needs no check.

  `routing` is the set of arguments your plugin reads itself whatever the
  tool declares, and writes again or drops before the call leaves — the
  project or the team a mission pins. Nothing else belongs there.

## Step 5 — Credential (`credential` in `src/index.ts`)

You declare **how** a connection is obtained; the gateway runs the flow,
stores the result encrypted and hands the decrypted secret to `execute` for
the duration of one call. A plugin writes no route, never reads the
environment and never sees an OAuth client secret. One `CredentialSpec` per
plugin — the one way of connecting, the simplest the provider offers: a key a
person makes by hand whenever the provider has one, `oauth2` only where it
has none (ADR
[one-place-to-authorize-services-token-first](../docs/decisions/one-place-to-authorize-services-token-first.md)) —
of one of three kinds:

| Kind      | When                                         | You declare                                                                                                                                      | `execute` receives                                           |
| --------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `api-key` | The user pastes a key or token.              | `fields` (at least one `secret: true`), `createUrl?`                                                                                             | `{ fields, metadata }`                                       |
| `oauth2`  | The user consents on the provider's page.    | `authorizationUrl`, `tokenUrl`, `clientRegistration`, `scopes`, `pkce`, `clientAuthMethod`, `refreshable`… — or `broker: { provider }`, `scopes` | `{ accessToken, refreshToken, expiresAt, scopes, metadata }` |
| `ssh-key` | The gateway generates a key pair for a host. | `algorithm: 'ed25519'`, `fields` (host, port, user)                                                                                              | `{ privateKeyPem, publicKey, fields, metadata }`             |

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

**`oauth2`.** Only for a provider that offers no key a person can make,
**and** that accepts dynamic client registration (RFC 7591): declare its
`clientRegistration.registrationUrl`, and the gateway registers its own
client there the first time someone connects (ADR
[oauth-client-registered-by-the-gateway](../docs/decisions/oauth-client-registered-by-the-gateway.md)).
`definePlugin` refuses an `oauth2` spec without it: nobody declares an OAuth
client by hand (ADR
[gmail-over-imap-with-an-app-password](../docs/decisions/gmail-over-imap-with-an-app-password.md)).
A provider with neither a key nor dynamic registration can take its client
from an **OAuth broker** the instance is enrolled with: declare `broker: {
provider }` and the `scopes`, nothing else (ADR
[google-calendar-through-an-oauth-broker](../docs/decisions/google-calendar-through-an-oauth-broker.md);
[`plugins/google-calendar/src/credential.ts`](./google-calendar/src/credential.ts)).
It may also offer another
protocol a person can open with a key (Gmail: IMAP with an app password,
[`plugins/gmail/src/credential.ts`](./gmail/src/credential.ts)). Set
`refreshable: true` when the token endpoint issues refresh tokens: the
gateway performs the standard `refresh_token` grant itself. Write
`refresh()` on the plugin only when the provider's refresh is not the
standard one.

**A token with a guide** (`api-key`). Give the connect page what it shows:
`label` (what the person creates, in the provider's words), `createUrl`,
`guide` — the steps at the provider, the `permissions` to tick with the
tools each serves (every tool of the plugin must be served by one;
`definePlugin` checks), the expiry to choose — and `verify(ctx)`, asked
before anything is stored: who the token acts as and when it expires, an
`UpstreamAuthError` for a rejected token. The worked example is
[`plugins/github/src/credential.ts`](./github/src/credential.ts) with its
permissions in [`permissions.ts`](./github/src/permissions.ts).

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
  cast it; refuse a payload you do not recognise, and pass every id it
  carries through the grammar of its kind before it becomes a `ref`.
- Follow the provider's pagination up to a ceiling, a named constant of the
  plugin that the README states ("at most 500 zones"). When the endpoint is
  not paginated, say so in the README.

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
  request: an unknown tool, an argument it cannot read, an undeclared
  argument, a target outside the mission, a guard that does not hold. Never
  catch a provider failure into an `isError` result: the audit would say the
  call went through.
- **Decline with `ExecutorRefusal`, never with a plain `Error`.** A refusal
  thrown as an `Error` is read as a provider failure: the audit records an
  upstream error although no request left, and the agent gets a transport
  error instead of a sentence it can act on. Return
  `refusalResult(message)` where the refusal is decided at the entry point,
  as the template's `refused` does; when it is decided deeper, throw
  `new ExecutorRefusal(message)` and wrap the body of `execute` in
  `declining(...)`, which turns that one error into the `isError` result and
  lets every other throw through:

  ```ts
  export function executeAcme(ctx, tool, args) {
    return declining(async () => {
      const id = pathIdent(args.widget_id);
      if (!id) throw new ExecutorRefusal(MALFORMED_WIDGET_ID); // declined: an isError result
      return text(await request(ctx, 'GET', `/widgets/${id}`)); // a failed status is thrown by request
    });
  }
  ```

- The provider's base URL is a constant of the plugin: it is a fact about the
  provider, not configuration of the instance.
- A success without content (a 204 after a `DELETE`) is not JSON: return a
  confirmation of your own, as the template does.

The full table is in the SDK handbook,
["The contract"](../docs/handbook/plugin-sdk.md#the-contract).

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
(handbook, ["The contract"](../docs/handbook/plugin-sdk.md#the-contract)).

**Environment in the call.** When the environment is part of the call rather
than a label on the resource (Vercel's `env[prod]` segment), declare
`envOf: envFromSliceSegment('env')` in `definePlugin`, or a pure function of
your own. Otherwise declare nothing. An `envOf` has three answers, and the
gateway reads them differently:

| `envOf` returns | When                                                                                                                | The gateway                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| a label         | the slice touches that one environment                                                                              | qualifies the touched risks with it                                                |
| `undefined`     | the slice says nothing about its environment                                                                        | falls back to the owner's label on the resource                                    |
| `NO_SINGLE_ENV` | the slice names its environment but not exactly one: a wildcard, a list, a glob, a label the provider does not have | resolves no environment, never the label: every env-scoped risk touched is refused |

Never answer `undefined` for the third case: the owner's label would price a
call that reaches production as whatever the resource happens to be
labelled. `envFromSliceSegment` already answers `NO_SINGLE_ENV` there
([risk model](../docs/spec/gateway-risk-model.md)).

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
([plugin SDK handbook](../docs/handbook/plugin-sdk.md)).
`definePlugin` validates the whole definition at import and reports every
problem at once.

**The SDK test kit is mandatory.** Keep `tests/unit/plugin.test.ts` from the
template and make it yours:

```ts
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  mockFetch,
  policyFromMacroActions,
} from '@vaubaan/plugin-sdk/testing';

assertPluginWellFormed(acmePlugin); // the definition and the catalog, fallback flag included
assertNoWildcard(acmePlugin); //       no `*` or `?` in a risk id
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

**Test a mission the way a creator composes it.** `policyFromMacroActions`
writes the explicit lines of ticked macro-actions at their trust levels, for the
environments given, with the policy engine's own rules (gate from the
tier, budget scaled by the trust level, a write-token handout asked first):

```ts
const policy = policyFromMacroActions(
  acmePlugin,
  { read: 'careful', change: 'trusting' },
  {
    envs: ['staging', 'prod'],
  },
);
// [{ risk_id: 'acme.read-widgets', gate: 'auto', … }, { risk_id: 'acme[prod].widget-write', … }, …]
```

`assertCatalogCoverage` fails when a tool has no sample, when a sample is
refused without `expectDenied` (or the reverse), when a slice matches no
risk of the catalog, when a slice does not read back as itself once written
(an identifier holds a character the slice grammar cannot carry: use
`identSegment`), and when a slice carries `*` inside an identifier. `fallbackHits` lists the samples only the fallback
covered: add the missing catalog entry. Coverage looks at which risks a slice
matches, not at the environment: samples on one resource are enough, and an
env-scoped risk counts as touched whatever the label.

**Run the identifier proof on the same samples.** `assertIdentifiersRefused`
feeds `..`, `.`, `a/../b`, `%2e%2e`, `..%2f`, `%2f`, a line break and
`r1?x=1#y` to every string argument of every sample, through your `classify`
and through your `execute`, and fails when a value your classifier refuses is
sent anyway, when a request carries a dot segment, when a delimiter reaches a
URL as it is, or when an accepted identifier is not the one the request
names:

```ts
const report = await assertIdentifiersRefused(acmePlugin, SAMPLES, {
  resources: [staging],
  context: (fetch, resources) => ({ credential, fetch, resources }),
});
expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getWidget, argument: 'widget_id' });
```

It finds the identifiers by running your samples: an argument whose sample
value is a segment of a request path. If it finds none it fails — give it
`routes` for what your executor reads first (a token, a lookup), or say
`pathIdentifiers: { none: '<why>' }` when your identifiers do not travel in a
path. The repository refuses a plugin whose tests do not run it. It does not
replace the cases of step 6 that only you know (a ref, a nested field, a
value that is legitimately dotted).

`mockFetch(routes)` returns a `fetch` that answers from a list of routes and
records what it was asked:

```ts
const fetch = mockFetch([
  { method: 'GET', url: `${ACME_API_BASE}/workspaces`, body: [{ id: 'ws-1', name: 'One' }] },
  { method: 'PATCH', url: /widgets\/w1$/, respond: (call) => ({ renamed: call.json }) },
  { method: 'DELETE', url: /widgets\/w1$/, status: 204 },
  { url: /widgets$/, status: 503, body: { error: 'down' }, times: 1 },
]);
// url: an exact string, a RegExp or a predicate; status defaults to 200; an object body is sent as JSON.
fetch.calls[0]; // { method, url, headers (lower-cased names), body, json }
```

Then write, in the same folder:

- **Classifier tests: one case per branch of `classify.ts`**, every refusal
  included (unknown tool, resource outside the mission, ambiguous resource,
  malformed identifier, undeclared argument). Build the cases from the
  provider's public documentation or recorded answers. This is where review
  time goes.
- **Hostile identifiers, fed to both sides**: `..`, `.`, `a/../b`, `%2e%2e`,
  `%2f`, an empty value, an overlong value, a line break and `?x=1#y`, in
  every identifier position of `classify` **and** of `execute`. A refused
  value sends no request (`fetch.calls` stays empty); an accepted one names
  exactly the classified resource. The gateway's structural suite fails for
  a plugin without such a test
  (`apps/gateway/tests/unit/structural/plugin-identifier-tests.test.ts`).
- **`execute` and `discoverResources` against `mockFetch([...routes])`**: the
  request sent (method, URL, headers, body), the two thrown failures, the
  `isError` refusals with no request sent, a payload discovery must refuse.
  An unmatched request fails the test. `refusalText(execute(...))` of the
  kit awaits the call, requires an `isError` result and returns its text; a
  refusal that is thrown fails the test as the provider failure it would be.
  In a table that feeds one argument object to several tools,
  `declaredOnly(plugin, tool, args)` keeps the entries each tool declares,
  so the undeclared-argument rule does not hide the rule under test.

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
resources, Tools, Catalog (one line per risk), Macro-actions, Tests.

**`docs/handbook/providers/<id>.md`** — for the reviewer and the next
maintainer: the model and the reasons behind it. Start it with this
frontmatter and cover these six subjects (the shipped handbooks do, under
headings of their own), plus an "Identifiers" paragraph that lists each
grammar and where the value lands, and a line saying whether the plugin
refuses undeclared arguments or builds its requests field by field:

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

## 3. Catalog and macro-actions

## 4. Coverage

## 5. Edge cases

## 6. Credential, discovery, execution, tests
```

"Coverage" is a table showing that every tool is covered by a named risk, not
by the fallback. "Edge cases" argues each classification that is not obvious:
it is the section a security reviewer reads. `tracks:` lists the files the
handbook describes; the project's drift check compares the two.

`tracks:` may list folders, as above, or individual files.

Add your plugin's row to the index table in
[`docs/handbook/providers/README.md`](../docs/handbook/providers/README.md),
in alphabetical order, with its seven columns (plugin, handbook, planes,
number of risks "+ fallback", macro-actions, credential kind, notes), and correct
the count of plugins in the sentence above the table. Optionally set
`docsUrl` in `definePlugin` to the handbook's address in the repository,
`https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/<id>.md`.

Hand-written Markdown tables rarely pass the format check; let Prettier
align them, then check that nothing is left of the scaffold:

```bash
npx prettier --write plugins/acme docs/handbook/providers
grep -rniE 'template|widget|example\.com' plugins/acme
```

## Step 10 — Register the plugin

A plugin under `plugins/` is tested by `npm run ci` but is not part of the
gateway until it is registered. One list holds the providers; everything else
("Connect an account", the setup checklist, Reference, the tool list)
derives from it.

1. `apps/gateway/package.json`: add `"@vaubaan/plugin-acme": "*"` to
   `dependencies`, then run `npm install`.
2. `apps/gateway/src/server/compose/shipped-plugins.ts`: one import of the
   default export, placed in alphabetical order of the package names, and
   one entry at the end of `SHIPPED_PLUGINS`.

Add the provider to no other list; if a test or a page needs the provider
list, it reads the registry. Every registered plugin is offered in the
connect and issuance flows and lists its tools to agents: there is no
"experimental" state (docs/handbook/plugin-sdk.md); a young plugin says so
with a version below `1.0.0`.

```bash
npm run ci                         # type-check, lint, format check, build, tests
```

The gate stops at its first failing stage, so a formatting complaint hides
the build and the tests. Fix it (`npm run format`) and run the gate again.

## Step 11 — Version, changelog, pull request

**Plugin version** — `version` in `src/index.ts` and in the plugin's
`package.json`, always equal (after changing it: `npm install`, which updates
`package-lock.json`). A new plugin starts at `0.1.0`. It is what telemetry
reports, so one version never designates two different classifiers.

| Change                                                                                                                   | From `1.0.0` | Before `1.0.0`        |
| ------------------------------------------------------------------------------------------------------------------------ | ------------ | --------------------- |
| A fix that changes no tool, risk or macro-action                                                                         | patch        | patch                 |
| A new tool, risk or macro-action; a widened pattern                                                                      | minor        | patch                 |
| A removed tool; a stricter classification (calls once allowed are refused); a change of what `execute` throws or returns | major        | minor (`0.2` → `0.3`) |

The third row is the one that is forgotten. A classification that became
stricter, or an executor that now refuses what it used to forward or
declines where it used to throw, changes what an agent's call does: it is a
major version, or a minor one before `1.0.0`. Closing the argument surface
of a plugin, binding an identifier to its resource, or pricing a statement
on a more severe risk are all breaking steps.

**Catalog version** — `catalog_version` in the YAML, an integer, independent
of the plugin version. Bump it and set `catalog_date` on every reviewed
change of the catalog's content: an entry, a pattern, a vector, a limit, a
macro-action, a label, a reason. Not for a YAML comment.

**Changelog** — one entry in the root [`CHANGELOG.md`](../CHANGELOG.md) under
`## [Unreleased]`, in `### Added` for a new plugin (`### Changed` or
`### Security` for a change), naming the plugin and its version:

```markdown
- **Acme plugin** (`@vaubaan/plugin-acme` 0.1.0): workspaces and widgets, API key,
  macro-actions `read` and `change`.
```

Plugins have no changelog of their own.

**Pull request** — one plugin per pull request, with the
[template checklist](../.github/PULL_REQUEST_TEMPLATE.md) answered. In the
description, link the plugin request issue and state which provider
documentation the classifier was written from. Expect the review to
concentrate on the catalog, the classifier's refusals and the handbook's
Traps.

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
  `replaced_by` when a successor exists; remove it from its macro-action.
- **Base budgets** of the macro-actions are a starting point chosen by the
  plugin's author; the gate follows the vector and the trust level. Propose a change with the usage that motivates it.

## When something fails

| Message                                                                               | Cause and fix                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot find package '@vaubaan/plugin-<id>'`                                          | The workspace is not linked: run `npm install` at the root.                                                                                                                                                                                                                                                                                        |
| `Invalid risk catalog '…'` followed by bullets                                        | Read every bullet; each path is exact (`risks[3].vector.blast`, `macro_actions[1].entries[2].risk_id`).                                                                                                                                                                                                                                            |
| `exactly one fallback entry per catalog, found 2`                                     | A second entry matches `<id>.**.W` or carries the flag: give it a narrower pattern.                                                                                                                                                                                                                                                                |
| `… is the fallback, which belongs to no macro-action`                                 | Remove the fallback from the macro-action; the gateway offers it as "Anything else".                                                                                                                                                                                                                                                               |
| `presets: presets were retired …`                                                     | Move the risks into `macro_actions` and delete the `presets` key.                                                                                                                                                                                                                                                                                  |
| `PluginDefinitionError … must start with '<prefix>'`                                  | A tool name was written by hand: build it in `identity.ts` with `toolPrefixFor`.                                                                                                                                                                                                                                                                   |
| `assertCatalogCoverage … no catalog risk matches it`                                  | The classifier emits a slice outside every `matches`. A read needs its own entry: the fallback only catches writes.                                                                                                                                                                                                                                |
| `assertCatalogCoverage … cannot be read back` or `… carries '*' inside an identifier` | The classifier wrote a raw value into an identifier segment: refuse it in its grammar, or emit `identSegment(value)` (step 4).                                                                                                                                                                                                                     |
| `<name>: not an argument of '<tool>' — nothing classifies it, so it is not sent.`     | The call (or a test sample) carries an argument the tool's schema does not declare: declare and classify it, or remove it; `declaredOnly` for shared test tables (step 8).                                                                                                                                                                         |
| The audit shows `upstream_error` for a call that sent nothing                         | `execute` threw a plain `Error` to decline: throw `ExecutorRefusal` under `declining`, or return `refusalResult` (step 7).                                                                                                                                                                                                                         |
| `report.fallbackHits` is not empty                                                    | A realistic call is covered by the fallback alone: add the catalog entry.                                                                                                                                                                                                                                                                          |
| `mockFetch: unexpected GET …`                                                         | The plugin requested a URL no route covers: add the route or fix the URL.                                                                                                                                                                                                                                                                          |
| `next build` fails reading `risk-catalog.yaml`                                        | The catalog is loaded with `new URL(…, import.meta.url)`: use `catalogPathNextTo(import.meta.url)`.                                                                                                                                                                                                                                                |
| `plugin-identifier-tests.test.ts` fails for `<id>`                                    | No test file of the plugin feeds `'..'` and an encoded or separator form (`%2e%2e`, `%2f`, `../`) to both `classify` and `execute` (step 8). The file is read with the TypeScript parser: the values must be string literals of the code, the classifier and the executor must be called, and at least one test must run (not `skip`, not `todo`). |

More cases: SDK handbook,
["Debug"](../docs/handbook/plugin-sdk.md#debug).

## Working with a coding agent

[`docs/skills/provider-modeler.md`](../docs/skills/provider-modeler.md) is the
same process written as instructions for a coding agent: it stops for a human
review of the model before any code is written.
