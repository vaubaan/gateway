# Provider plugins

One folder per provider, published as `@vaubaan/plugin-<provider>`. A plugin
declares a provider's tools and data model, classifies each call into the
risks of its catalog (`risk-catalog.yaml`), executes the call upstream with
the credential the gateway hands it, declares how that credential is
obtained and refreshed, discovers the resources a connection can reach, and
ships at least one **preset**.

Current plugins: `cloudflare-dns`, `github`, `gmail`, `railway`, `resend`,
`ssh`, `stripe`, `supabase`, `upstash-redis`, `vercel`. Feature P1.2
migrates them to the SDK one by one: `github`, `railway`, `stripe`,
`supabase`, `upstash-redis` and `vercel` are on it (their v4 exports stay
`@deprecated` until P1.6); `cloudflare-dns`, `gmail`, `resend` and `ssh`
still use the v4 adapter shape. `_template` is the scaffold, already on the
SDK.

The contract is `@vaubaan/plugin-sdk` (`packages/plugin-sdk`), fixed by the
ADR [`plugin-contract-and-credential-spec`](../docs/decisions/plugin-contract-and-credential-spec.md)
and described in the handbook
[`plugin-sdk`](../docs/handbook/plugin-sdk.md). A plugin imports the SDK
only — never the gateway application.

## Writing a plugin

1. **Open a plugin request** —
   [issue template](../.github/ISSUE_TEMPLATE/plugin_request.yml) — so the
   risk catalog is discussed before code. The modelling method (data model,
   tool → slice mapping, catalog, coverage matrix, edge cases) is the one
   the existing per-provider handbooks follow:
   [`docs/handbook/providers/`](../docs/handbook/providers/README.md).
2. **Copy `_template`** to `plugins/<provider>` and rename `template` to
   your provider id everywhere: folder, `package.json` name, `id` in
   `src/index.ts`, `provider:` in the YAML, tool prefix, data-model
   provider. The id is a lowercase slug (`cloudflare-dns`); the tool prefix
   turns `-` into `_` (`cloudflare_dns__`).
3. **Model** — `src/data-model.ts`: the entities a slice path can name,
   per plane, with containment and cardinalities. Mark the entity that
   carries the environment (`envScopable`).
4. **Catalog** — `src/risk-catalog.yaml`:

   ```yaml
   provider: <id>
   catalog_version: 1
   catalog_date: 2026-10-13
   risks:
     - id: <id>.<name> # never renamed, never deleted — deprecate instead
       label: 'Short label'
       reason: 'Why this is a risk, two sentences at most.'
       matches: '<id>.<entity>[**].<leaf>[**].W' # one pattern or a list
       acceptable_in_envs: [staging, prod] # optional: makes the risk env-scoped
       vector: { reversibility: …, blast: …, data: …, cost: …, visibility: …, persistence: … }
     - id: <id>.uncategorized-write # mandatory fallback
       matches: '<id>.**.W'
       …
   presets:
     - id: developer
       label: Developer
       description: One line shown in the issuance UI.
       entries:
         - risk_id: <id>.<name> # a risk of THIS catalog; env-qualified allowed
           quota: 500 # actions per period — always a number
           rate_limit: { max: 30, window_seconds: 60 }
           gate: auto # auto | approval
   ```

   The loader refuses, at boot and in tests: unknown keys, malformed ids,
   patterns of another provider, a missing fallback, zero presets, a preset
   entry that is not an explicit risk of this catalog, a deprecated risk in
   a preset, a non-numeric budget.

5. **Tools** — `src/tools.ts`: `McpToolDeclaration[]`, names
   `<prefix>__<verb>_<noun>`, JSON input schemas. Take the resource ref as an
   explicit argument.
6. **Classify** — `src/classify.ts`: `(tool, args, resources) → { slices }
| { denied }`. Pure. Every tool maps to at least one slice; a call you
   cannot place on the data model is `denied`, never mapped to a broad slice.
   Validate identifiers before embedding them in a slice. This is the
   security-critical file; test every branch.
7. **Execute and discover** — `src/execute.ts`: use `ctx.fetch` (never the
   global), the secret from `expectCredentialKind(...)`, throw
   `UpstreamAuthError` on 401/403, return an `McpToolResult`.
   `discoverResources` lists the refs the owner will label.
8. **Credential** — in `src/index.ts`, the `credential: CredentialSpec`:
   `api-key` (form fields), `oauth2` (authorize/token URLs, scopes, PKCE,
   client-auth method, `refreshable` + a `refresh()`), `app-install`
   (operator app settings, install URL), or `ssh-key`. The gateway runs the
   flow; you declare it.
9. **Wire** — `definePlugin({...})` in `src/index.ts`. It validates the
   whole definition at import time and lists every problem at once.

## Testing a plugin

Keep `tests/unit/plugin.test.ts` from the template and extend it:

```ts
import { assertCatalogCoverage, assertNoWildcard, assertPluginWellFormed, assertPresetsValid, mockFetch }
  from '@vaubaan/plugin-sdk/testing';

assertPluginWellFormed(plugin);
assertPresetsValid(plugin);
assertNoWildcard(plugin);
assertCatalogCoverage(plugin, { '<prefix>__list_x': [{ args: {…} }], … }, { resources: [...] });
```

- `assertCatalogCoverage` needs one realistic sample call per declared tool
  and checks that every emitted slice is covered by a risk of your catalog.
- Classifier tests: one case per branch of `classify.ts`, including the
  `denied` paths. A classification error is a security hole (spec §10).
- `execute` and `discoverResources` run against `mockFetch([...routes])`;
  an unmatched request fails the test. **No test ever calls a real
  provider.**

`npm run ci` (type-check, lint, format, tests, build) must be green.

## Shipping a plugin

- Bump `version` in `src/index.ts` (semver: patch = fix without risk/tool/
  preset change; minor = new tool, risk, preset or widened pattern; major =
  removed tool or stricter classification) and `catalog_version` in the
  YAML on every reviewed catalog change.
- Add a `CHANGELOG.md` entry under `[Unreleased]`.
- Write or update the provider handbook under `docs/handbook/providers/`.
- Open the pull request with the template checklist. Packages stay
  workspace-internal until a third-party plugin exists (layout ADR).

## Contributing

Read [`CONTRIBUTING.md`](../CONTRIBUTING.md) first (doc-first rule,
English only, local CI gate).
