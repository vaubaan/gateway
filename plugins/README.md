# Plugins — the first-party plugins of this repository

A **plugin** teaches the gateway one service (GitHub, Supabase, Gmail…): its
data model, its risk catalog and macro-actions, the classifier that sorts
each call, the credential, resource discovery and the calls to the service.

**Writing a plugin?** The author's guide is on the site,
[vaubaan.com/docs/plugins-guide](https://vaubaan.com/docs/plugins-guide): a
tutorial, one page per step, the command line and the catalog file,
written for the published kit (`npx @vaubaan/plugin-cli init`) and the
[catalog](https://github.com/vaubaan/gateway-plugins), outside this
repository ([ADR](../docs/decisions/user-and-author-docs-live-on-the-site.md)).
Every rule of that guide holds here too; this page adds only what differs
for the plugins maintained in this repository.

- **The first-party plugins**: every folder of `plugins/` but `_template`. They
  are the catalog's sources, the set the tests and the demo run
  ([`repository.ts`](../apps/gateway/tests/support/plugins/repository.ts)),
  and the pages under [vaubaan.com/plugins](https://vaubaan.com/plugins).
  Their modelling notes are indexed in
  [`docs/handbook/services/README.md`](../docs/handbook/services/README.md).
- **`_template`** is a complete plugin for an imaginary service: the scaffold
  `vaubaan-plugin init` publishes (`packages/plugin-cli` copies it into its
  package), the base of a new folder here, and a fixture of the structural
  tests. Keep it passing.
- **The contract**: `@vaubaan/plugin-sdk` (`packages/plugin-sdk`), handbook
  [`plugin-sdk`](../docs/handbook/plugin-sdk.md), ADR
  [`plugin-contract-and-credential-spec`](../docs/decisions/plugin-contract-and-credential-spec.md).
  A plugin imports the SDK (`@vaubaan/plugin-sdk`, `/testing`, `/git`) and
  nothing else of the gateway, its tests included: the lint rule of
  `plugins/**` in `eslint.config.js` refuses any other `@vaubaan/*` import.

## A new plugin in this repository

1. **Agree first.** Record the plugin as a proposed intent
   ([`docs/intents/`](../docs/intents/)), with its tools and its dangerous
   operations: the risk catalog is what reviewers argue about.
2. **Copy the template** and link the workspace:

   ```bash
   cp -r plugins/_template plugins/acme
   npm install                      # links plugins/acme, updates package-lock.json (commit it)
   npx vitest run plugins/acme      # the template's tests, under your id
   ```

   Give the copy its identity in `package.json` (`"name": "@vaubaan/plugin-acme"`),
   `src/identity.ts` (`SERVICE_ID`), `src/icon.ts` and `src/risk-catalog.yaml`
   (`service:` and the `template` prefix of every id and pattern), and rename the
   exported symbols (`templatePlugin` → `acmePlugin`…). Ignore the audit summary
   `npm install` prints; never `npm audit fix`, which rewrites the lockfile.

3. **Write it** as the guide says, step by step. The in-repository checks:

   ```bash
   npx tsc -p plugins/acme --noEmit   # after each file
   npx vitest run plugins/acme        # a plugin has no `test` script here
   npx eslint plugins/acme --max-warnings=0
   npx prettier --check plugins/acme
   grep -rniE 'template|widget|example\.com' plugins/acme   # must print nothing at the end
   ```

   The repository's structural tests hold every plugin here to more than the kit
   does: ids and tool names written only in `identity.ts`, `tools.ts` and the YAML
   (`plugin-names-declared-once.test.ts`); a test that feeds hostile identifiers
   to both `classify` and `execute` (`plugin-identifier-tests.test.ts`); the
   transport (`plugin-transport.test.ts`); an icon (`plugin-icons.test.ts`); a
   complete token guide (`token-guides.test.ts`); a narrative per macro-action
   and a title per tool; versions equal in `definePlugin` and `package.json`,
   and stated nowhere else (`plugin-versions.test.ts`).

4. **Document it**, in the same pull request:
   - `plugins/acme/README.md`: a front door only — one paragraph on the
     service, a link to its page `https://vaubaan.com/plugins/acme` (the
     permissions, macro-actions and connect guide are generated there), a
     link to its handbook, and the tests command. No count, table or version
     copied from the code: they drift.
   - `docs/handbook/services/acme.md`: the model and the reasons behind it, for
     the reviewer and the next maintainer (see below), and its row in the index
     table of [`docs/handbook/services/README.md`](../docs/handbook/services/README.md).
5. **Make it reachable**: the tests, the demo and the browser tests know it
   through `apps/gateway/package.json` (`"@vaubaan/plugin-acme": "*"` in
   `devDependencies`, then `npm install`) and
   [`tests/support/plugins/repository.ts`](../apps/gateway/tests/support/plugins/repository.ts)
   (one import, one entry, alphabetical). Once on `main`, a pull request to
   [vaubaan/gateway-plugins](https://github.com/vaubaan/gateway-plugins) adds
   `catalog/acme.yaml` (`repo: https://github.com/vaubaan/gateway`,
   `path: plugins/acme`, the version, the `main` commit); merged, the catalog
   rebuilds, signs and publishes it. Then record the version and sha256 of that
   release in `apps/gateway/src/server/plugins/catalog-versions.json`
   (`catalog-versions.test.ts`). Add the service to no other list.
6. **Version, changelog, pull request**: the version rules are the guide's
   ([versions](https://vaubaan.com/docs/plugins-guide/sign-and-deploy#versions)).
   One entry in the root [`CHANGELOG.md`](../CHANGELOG.md) under
   `## [Unreleased]` (`### Added` for a new plugin, `### Changed` or
   `### Security` for a change), naming the plugin and its version; plugins
   have no changelog of their own. One plugin per pull request, the
   [checklist](../.github/PULL_REQUEST_TEMPLATE.md) answered, naming the
   service documentation the classifier was written from. `npm run ci` before
   pushing.

### The service handbook

`docs/handbook/services/<id>.md` starts with this frontmatter and covers six
subjects, plus an "Identifiers" paragraph (each grammar and where the value
lands) and a line saying whether the plugin refuses undeclared arguments or
builds its requests field by field:

```markdown
---
title: Acme plugin
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - plugins/acme/src/
  - plugins/acme/tests/unit/
---

# Acme plugin

## 1. Data model

## 2. Tool → slice mapping

## 3. Catalog and macro-actions

## 4. Coverage

## 5. Edge cases

## 6. Credential, discovery, execution, tests
```

"Coverage" shows that every tool is covered by a named risk, not by the
fallback. "Edge cases" argues each classification that is not obvious: it is
the section a security reviewer reads.

### How a plugin reaches an instance

From the catalog (`vaubaan/gateway-plugins`), which rebuilds, signs and publishes each version: an
instance installs it when a person first connects the service, or an administrator installs a
version; an operator may also pin the catalog's archive, unpacked, in `plugins.dir`. A plugin
version is released by a pull request on the catalog, never by a gateway release. Only `vaubaan`
and `ssh` (a native addon: `"vaubaan": { "bundleable": false, "reason": "…" }`) are compiled into
the server. Decisions:
[plugins-installed-when-first-needed](../docs/decisions/plugins-installed-when-first-needed.md),
[plugins-bundled-or-pinned-by-the-operator](../docs/decisions/plugins-bundled-or-pinned-by-the-operator.md);
for operators: [plugins on an instance](https://vaubaan.com/docs/operations/plugins); internals:
[plugin-loading](../docs/handbook/plugin-loading.md).

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
  plugin's author; the gate follows the vector and the trust level. Propose a
  change with the usage that motivates it.

## When something fails here

The kit's messages: [when something fails](https://vaubaan.com/docs/plugins-guide/reference/errors).
Those of this repository only:

| Message                                            | Cause and fix                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot find package '@vaubaan/plugin-<id>'`       | The workspace is not linked: run `npm install` at the root.                                                                                                                                                                                                                                                                               |
| `next build` fails reading `risk-catalog.yaml`     | The catalog is loaded with `new URL(…, import.meta.url)`: use `catalogPathNextTo(import.meta.url)`.                                                                                                                                                                                                                                       |
| `plugin-identifier-tests.test.ts` fails for `<id>` | No test file of the plugin feeds `'..'` and an encoded or separator form (`%2e%2e`, `%2f`, `../`) to both `classify` and `execute`. The file is read with the TypeScript parser: the values must be string literals of the code, the classifier and the executor must be called, and at least one test must run (not `skip`, not `todo`). |

More cases: SDK handbook, ["Debug"](../docs/handbook/plugin-sdk.md#debug).

## Working with a coding agent

The kit's skills (`packages/plugin-cli/scaffold/.claude/skills`) are the
same steps written for a coding agent, each linking its page of the guide;
they work in a folder of this repository too, with the commands above in
place of `npm run check`.
