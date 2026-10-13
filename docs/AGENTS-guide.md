---
title: Guide for coding agents — method and map of the repository
status: current
date: 2026-10-13
---

# Guide for coding agents

How to work in this repository when you are a coding agent (Claude Code,
Codex, Cursor or another), or a person who wants to work the way the
maintainers' agents do. It states the method and gives the map; it does not
repeat what the documents it points to already say.

This file is committed and written by hand. The maintainers also use a
private tool that generates `AGENTS.md` and `CLAUDE.md` at the root of their
checkouts; those two files are ignored by git and are not part of the
repository. If your agent looks for an `AGENTS.md`, point it here.

## The method: documentation first

The order is fixed:

1. **Understand** what the documentation says about the area you will
   touch.
2. **Fill the gaps** you find, before writing code.
3. **Write** the code and its tests.
4. **Update** the documentation the change made stale.
5. **Commit** code, tests and documentation together.

The documentation has six parts, each with one job:

| Part      | Where                                                             | Says                                        | When you touch it                                      |
| --------- | ----------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| README    | [`README.md`](../README.md)                                       | what the product is, how to try and install | the pitch, the quick start or the links change         |
| Spec      | [`docs/spec/`](spec/)                                             | _what_ and _why_, without technology        | **not from a coding task**; see below                  |
| Decisions | [`docs/decisions/`](decisions/)                                   | one choice each, and what was rejected      | you make a choice someone could question in six months |
| Handbook  | [`docs/handbook/`](handbook/README.md)                            | _how the code works today_                  | you change the behaviour of code a handbook describes  |
| Tests     | [`docs/tests/`](tests/)                                           | the integration and end-to-end scenarios    | you add, change or remove a scenario                   |
| Workflow  | [`docs/workflow/coding-workflow.md`](workflow/coding-workflow.md) | CI, branches, pull requests, releases       | the pipeline, the scripts or the branch model change   |

Rules that follow from it:

- **No code without a spec.** If the subsystem you touch has no spec, or
  the spec is silent on your point, stop and report it. Do not guess.
- **The spec is not edited from a coding task.** A change of behaviour
  starts with a change of spec, discussed and settled first.
  [`docs/spec/vaubaan-gateway.md`](spec/vaubaan-gateway.md) is the source of
  truth for the product,
  [`docs/spec/gateway-risk-model.md`](spec/gateway-risk-model.md) for the
  risk model. If you find the spec and the code in disagreement, report it;
  do not fix either silently.
- **A decision gets an ADR.** One file per decision under
  `docs/decisions/<slug>.md`, no number in the name, with frontmatter
  (`title`, `status: accepted`, `date`) and four sections: Context,
  Decision, Consequences, Rejected alternatives. A later ADR extends or
  supersedes an earlier one. A refinement of a current ADR is a dated
  `## Amendment` section added at its end, after the rejected alternatives,
  with a one-line pointer at the top
  ([rule](decisions/legacy-status-of-v4-adrs-and-handbooks.md)). ADRs from
  before the on-prem version are never edited.
- **A handbook follows its code.** Each handbook lists the files it
  describes in a `tracks:` list in its frontmatter and carries a
  `last_synced` date. When you change a tracked file, read the handbook and
  correct it in the same commit. When you add a module, add it to a
  handbook, or write one.
- **Never "documentation later".** A commit that changes behaviour and
  leaves its handbook stale is an incomplete commit.

## Rules of this code base

These are checked by tests or by review. The reasons are in the documents
linked.

- **English only**: code, comments, documentation, commit messages.
  Documents from before the on-prem version are kept under `legacy/`
  folders or carry a banner; they are not translated and not maintained.
- **Never an "everything".** Accepted risks, share restrictions and presets
  are explicit lists of `RiskId`. No wildcard, no sentinel, no reference to
  a preset in anything stored. "Select all" in the interface records the
  list as it is at that moment.
- **Nothing hard-coded.** No URL, secret or project reference in code. Configuration comes from the environment or the mounted
  file, through the configuration module; a missing key stops startup with
  a message naming it ([configuration](handbook/configuration.md)).
- **One list of providers.** Every list of providers is derived from the
  plugin registry. Do not write a second one, in code or in a test.
- **A plugin classifies; it does not decide.** A plugin knows its provider
  and nothing about missions, risks accepted or budgets. A classification
  error is a security hole: when a classifier cannot tell what a call does,
  it must emit every slice the call could touch
  ([risk model](spec/gateway-risk-model.md) §7).
- **A catalog states only what is enforced.** In particular, no scope cap
  in a shipped catalog beyond the one the gateway applies
  ([risk model](spec/gateway-risk-model.md) §4bis).
- **The three credentials never cross.** Mission token, delegated token,
  browser session: each opens one surface. Do not add a path that lets one
  act for another ([spec](spec/vaubaan-gateway.md) §6).
- **Keep a larger deployment possible.** Today an instance is one process
  with an embedded database. Storage sits behind repository interfaces with
  portable SQL; rate limits, caches and sessions sit behind interfaces. Mark
  any in-memory state `// single-process only`, naming the interface that
  would replace it.
- **No secret in logs, no arguments in the audit.** Tokens are logged by
  prefix; arguments are stored as a fingerprint only.
- **Tests never reach a real provider.** Unit tests sit beside the code or
  under `tests/unit`; integration tests run on an in-memory store with a
  simulated identity provider; plugins use the SDK's mocked `fetch`.
- **Library APIs are checked, not remembered.** Before using an external
  library's API, read its current documentation.

## Map of the repository

```
apps/gateway/                    the deployable (@vaubaan/gateway-app)
  src/app/                       pages and route handlers (Next.js App Router)
    (app)/                       signed-in pages: connections, shares, missions,
                                 requests, delegations, audit
    (public)/                    sign-in
    admin/                       operator pages
    mcp/                         the two MCP doors (/mcp, /mcp/manage)
    oauth/, .well-known/         the authorization server of the management door
    api/, auth/, r/              form handlers, sign-in callback, request links
  src/components/                shared interface components; ui/ holds the primitives
  src/styles/tokens.css          the design tokens
  src/server/                    everything that is not a page
    config/ compose/             configuration, composition root
    store/ crypto/               embedded database, migrations, encryption at rest
    auth/ groups/ authority/     sign-in, groups, who may accept what
    connections/ provider-apps/  connections, resources, the company's provider apps
    shares/ missions/            shares, issuance and its preview
    execution/ budget/           the execution door, counters and rate windows
    requests/                    claims and approvals
    management/ oauth-as/        the management door and its authorization server
    audit/ telemetry/            audit search and retention, opt-in reports
    http/ logging/ rate-limit/   shared plumbing
  tests/                         unit, integration, e2e (Playwright), demo, manual
packages/
  shared/                        domain types, RiskId, risk and catalog types
  policy-engine/                 slices, matching, the risk decision, the budget rule
  gateway-core/                  the call pipeline, refusals, the audit entry shape
  plugin-sdk/                    plugin contract, catalog loader, registry, test kit
  telemetry/                     report shape, queue, client
plugins/
  <provider>/                    data model, classifier, executor, risk-catalog.yaml, tests
  _template/                     the starting point for a new plugin
deploy/                          Dockerfile, Compose file, proxy and example configuration
docs/                            the five documentation folders, and skills/
scripts/                         gen-master-key
```

Where to read first, by task:

| Task                                    | Start with                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything                                | [spec](spec/vaubaan-gateway.md) §0 (vocabulary), then the [handbook index](handbook/README.md)                                                                              |
| A change to how a call is decided       | [risk model](spec/gateway-risk-model.md), handbooks [policy-engine](handbook/policy-engine.md) and [gateway-core](handbook/gateway-core.md)                                 |
| A new provider, or a change to a plugin | [`plugins/README.md`](../plugins/README.md), [`docs/skills/provider-modeler.md`](skills/provider-modeler.md), [plugin-sdk](handbook/plugin-sdk.md), the provider's handbook |
| A page of the interface                 | [web-app](handbook/web-app.md), [style guide](spec/style-guide.md)                                                                                                          |
| The database                            | [store](handbook/store.md)                                                                                                                                                  |
| Configuration, deployment               | [configuration](handbook/configuration.md), [`deploy/README.md`](../deploy/README.md)                                                                                       |
| The process itself                      | [`CONTRIBUTING.md`](../CONTRIBUTING.md), [workflow](workflow/coding-workflow.md)                                                                                            |

## Working loop

```bash
npm ci                 # once
npm run ci             # type-check, lint, format check, build, tests: the gate
npx vitest run <path>  # one package or one file while you work
npm run demo           # the whole interface locally, simulated providers
```

- Branches, commit message format and the pull request checklist:
  [workflow](workflow/coding-workflow.md), "Branches and pull requests".
- The pre-commit hook checks lint and formatting of staged files only. Run
  `npm run ci` yourself before you say a change is done.
- A database change is a new, numbered, forward-only migration; never edit
  one that exists ([store](handbook/store.md)).
- User-visible changes get a line in [`CHANGELOG.md`](../CHANGELOG.md)
  under "Unreleased".

## Before you report a change as done

- [ ] The spec covers what you built; anything it does not cover is
      reported, not assumed.
- [ ] Each choice someone could question has an ADR.
- [ ] Every handbook whose tracked files you changed is corrected, with
      `last_synced` updated.
- [ ] New scenarios are listed under `docs/tests/`.
- [ ] `npm run ci` is green, run by you.
- [ ] Your report says what you did not do and what you found broken and
      left alone.
