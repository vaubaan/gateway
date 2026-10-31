<!--
Thank you for contributing. One feature or one fix per pull request.
The title follows Conventional Commits (feat(scope): …, fix(scope): …, docs: …): pull requests are squash merged.
A vulnerability is not fixed in a public pull request first: see SECURITY.md.
-->

## What and why

<!-- One paragraph: what changes and why. Link the issue ("Closes #123") if there is one. -->

## How it was tested

<!-- The tests added or changed, and anything you checked by hand (for the interface: `npm run demo`). -->

## Checklist

Tick what is done; explain under "Notes for the reviewer" what is not or does not apply.

- [ ] **Specification** — this does not change what the product does or why; or the change to `docs/spec/` was agreed in an issue first (link it).
- [ ] **Decision** — every non-trivial choice (a library, a public contract, a structural change, a renamed domain term) has an ADR under `docs/decisions/` with Context, Decision, Consequences and Rejected alternatives.
- [ ] **Handbook** — the handbook of every subsystem touched describes the code as it is now, and its `tracks:` list covers the files changed.
- [ ] **Tests** — unit tests beside the code; new integration or browser scenarios listed in `docs/tests/`; no test calls a real provider.
- [ ] **English** — every new or modified file, comment and message.
- [ ] **No hard-coded configuration** — no instance URL, secret, project or account identifier; no second list of providers; no wildcard in a list of risks.
- [ ] **Local gate** — `npm run ci` is green (type-check, lint, format check, build, tests).
- [ ] **Sign-off** — every commit carries a `Signed-off-by:` line (`git commit -s`, see CONTRIBUTING.md).
- [ ] **CHANGELOG** — an entry under `## [Unreleased]` when the change is visible to a user, an operator or a plugin author.

### For a provider plugin or a risk catalog

Delete this section when the pull request touches nothing under `plugins/`.

- [ ] The classifier was written from the provider's documentation (link below), and every branch of `classify.ts` has a test, refusals included.
- [ ] The SDK test kit passes: `assertPluginWellFormed`, `assertNoWildcard`, `assertCatalogCoverage` with at least one sample per tool, `assertIdentifiersRefused` and `assertSlicesOnDataModel` on the same samples, no `fallbackHits`; the executor calls its provider through the SDK's transport (`httpJson` or the MCP client).
- [ ] The catalog has exactly one `fallback: true` entry, in no macro-action; every other risk belongs to exactly one macro-action, with a base budget; no risk id was renamed or deleted (deprecated instead).
- [ ] `catalog_version` and `catalog_date` are bumped for a change of the catalog's content; the plugin `version` is bumped per the rule of `plugins/README.md` and equals the one in its `package.json`.
- [ ] `plugins/<provider>/README.md` and `docs/handbook/providers/<provider>.md` (with its row in the index) are written or updated.
- [ ] A new plugin is registered in `apps/gateway/src/server/compose/shipped-plugins.ts` and nowhere else.

Provider documentation used:

## Notes for the reviewer

<!-- What you decided alone, left out on purpose, or want a second opinion on. -->
