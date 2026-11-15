---
title: Guide for coding agents
---

# Guide for coding agents

How the documentation of this repository is organised, and how to work in it as a coding agent or
as a person working the way the maintainers do. Most commits are co-authored with coding agents
under a maintainer's review ([MAINTAINERS](../MAINTAINERS.md)); the rules below are what keeps
their work reviewable.

**Reading as a person?** Start with [architecture](architecture.md) (ten minutes), then the
[handbook index](handbook/README.md). The rest of `docs/` is a reference you open when a change
touches it:

- `spec/` says what the product does and why, without technology;
- `decisions/` holds one file per structural choice and the options it rejected;
- `handbook/` says what the code does not say on its own: entry points, traps, procedures;
- `tests/` and `workflow/` describe the test suites and the CI, branch and release process.

`AGENTS.md` and `CLAUDE.md` at the root, and the `.claude/`, `.agents/` and `.opencode/` folders,
are generated from `docs/` by `@vaubaan/harness` and committed: the CI linter checks that they
match their sources. Change the sources, run `npx @vaubaan/harness update .`, commit the result.
Point an agent that looks for `AGENTS.md` here.

## Documentation first

The order is fixed: **understand** the docs of the area → **fill the gaps** → code and tests →
**update** the docs the change made stale → commit all three together.

| Part                                    | Says                                 | When you touch it                                      |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| [Spec](spec/)                           | _what_ and _why_, without technology | **not from a coding task**                             |
| [Decisions](decisions/)                 | one costly-to-reverse choice each    | you make a choice someone could question in six months |
| [Handbook](handbook/README.md)          | what the code does not say           | you change the behaviour of code it tracks             |
| [Tests](tests/)                         | scope, stack, conventions, gaps      | you change the test infrastructure                     |
| [Workflow](workflow/coding-workflow.md) | CI, branches, pull requests, release | the pipeline, the scripts or the branch model change   |

- **No code without a spec.** No spec for the subsystem, or silent on your point: stop and report
  it. Spec and code disagree: report it, fix neither silently.
  [`vaubaan-gateway`](spec/vaubaan-gateway.md) is the product's source of truth,
  [`gateway-risk-model`](spec/gateway-risk-model.md) the risk model's.
- **An ADR states the decision in force**: `docs/decisions/<slug>.md`, sections Context, Decision,
  Consequences, Rejected alternatives. A change rewrites it; a replaced ADR is deleted and its
  option goes to the successor's Rejected alternatives.
- **A handbook follows its code**: its `tracks:` lists what it covers; a change to a tracked file
  corrects the handbook in the same commit and moves `last_reviewed`.

## Rules of this code base

Checked by tests or review; the reasons are in the linked documents.

- **English only**: code, comments, docs, commits.
- **Never an "everything"**: accepted risks, share restrictions and presets are explicit `RiskId`
  lists; nothing stored holds a wildcard, a sentinel or a preset reference.
- **Two sets of words**: the protocol (spec, code, API, catalogs, store) and the interface
  ([spec](spec/vaubaan-gateway.md) §0). `apps/gateway/src/lib/vocabulary.ts` is the one bridge;
  never rename a protocol name or print one as prose on a page.
- **Nothing hard-coded**: configuration comes through the configuration module; a missing key stops
  startup, naming it ([configuration](handbook/configuration.md)).
- **One list of services**, the plugin registry; never a second one, in code or test.
- **A plugin classifies; it does not decide**, and a classifier that cannot tell emits every slice
  it could touch ([risk model](spec/gateway-risk-model.md) §7).
- **Keep a larger deployment possible**: storage behind repository interfaces with portable SQL;
  in-memory state marked `// single-process only`, naming the interface that would replace it.
- **Tests never reach a real service**; plugins test on the SDK's mocked `fetch`.
- **Library and service APIs are checked, not remembered**
  ([workflow](workflow/coding-workflow.md), Context7).

## Where to read first

| Task                                   | Start with                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anything                               | [spec](spec/vaubaan-gateway.md) §0 (vocabulary), then the [handbook index](handbook/README.md)                                                                           |
| A change to how a call is decided      | [risk model](spec/gateway-risk-model.md), handbooks [policy-engine](handbook/policy-engine.md) and [gateway-core](handbook/gateway-core.md)                              |
| A new service, or a change to a plugin | [`plugins/README.md`](../plugins/README.md), [`docs/skills/service-modeler.md`](skills/service-modeler.md), [plugin-sdk](handbook/plugin-sdk.md), the service's handbook |
| A page of the interface                | [web-app](handbook/web-app.md), [style guide](spec/style-guide.md)                                                                                                       |
| The database                           | [store](handbook/store.md)                                                                                                                                               |
| Configuration, deployment              | [configuration](handbook/configuration.md), [`deploy/README.md`](../deploy/README.md)                                                                                    |
| The process itself                     | [`CONTRIBUTING.md`](../CONTRIBUTING.md), [workflow](workflow/coding-workflow.md)                                                                                         |

## Before you report a change as done

- [ ] The spec covers what you built; anything it does not cover is reported, not assumed.
- [ ] Each choice someone could question has an ADR.
- [ ] Every handbook whose tracked files you changed is corrected.
- [ ] `npm run ci` is green, run by you; `npm run demo` shows the interface locally.
- [ ] Your report says what you did not do and what you found broken and left alone.
