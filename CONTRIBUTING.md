# Contributing to Vaubaan Gateway

Vaubaan Gateway is an open source, on-prem MCP gateway: coding agents work
under a mission with a risk budget instead of holding cloud credentials. This
page tells you how to set the repository up, how changes are prepared here,
and what a pull request must contain.

Ways to contribute:

- report a bug, or a place where the product does not do what the
  specification says;
- propose a feature;
- **write a provider plugin**, or correct the risk catalog of an existing
  one: see [`plugins/README.md`](plugins/README.md), the step-by-step guide;
- improve the documentation.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems are **not** reported in public issues: see
[Security issues](#security-issues).

## Prerequisites

- **Node.js 26 or later and npm 11 or later** (CI and the image run Node 26).
- **Git.**
- Nothing else for the everyday work: no database, no cloud account, no
  provider credential. The test suite makes no network call.
- Optional: Chromium for the browser tests (installed by one command below),
  and Docker if you want to build the image.

## Set up

```bash
git clone https://github.com/vaubaan/gateway.git
cd vaubaan-gateway
npm ci            # installs every workspace
npm run ci        # the gate: type-check, lint, format check, build, tests
```

`npm run ci` takes a few minutes and must be green before you change
anything; if it is not, that is a bug worth reporting.

## Look at the product

```bash
npm run demo      # builds when the sources changed, then serves the whole interface on http://localhost:3210
```

The demo is the real application with a simulated identity provider (an
account picker, no password), simulated providers and seeded data: sign in as
Alice and click through Now, Waiting for you, Missions, Accounts, Activity
and Reference.
Nothing leaves your machine, and the data is deleted when you stop it with
`Ctrl-C`. `DEMO_PORT=<port>` changes the port. Use Chrome or Firefox. Details:
[`docs/handbook/demo-mode.md`](docs/handbook/demo-mode.md).

It is the fastest way to understand the vocabulary used everywhere else
(connection, resource, share, mission, risk, budget, gate, request).

To run a real instance with your own identity provider, follow
[`deploy/README.md`](deploy/README.md) (Docker Compose). You do not need one
to contribute.

## Run the tests

| Command                 | What it runs                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `npm run ci`            | Everything below except the browser tests and the image. The gate of every pull request. |
| `npm run type-check`    | `tsc --noEmit` in every workspace.                                                       |
| `npm run lint`          | ESLint, warnings are errors. `npm run lint:fix` fixes what it can.                       |
| `npm run format:check`  | Prettier. `npm run format` rewrites the files.                                           |
| `npm run build`         | The production build of the application.                                                 |
| `npm run test`          | Vitest: unit and integration tests of every workspace.                                   |
| `npx vitest run <path>` | One folder or one file, for example `npx vitest run plugins/github`.                     |
| `npm run test:e2e:v5`   | Builds, then the browser tests (Playwright) against an instance started for the run.     |
| `npm run docker:build`  | Builds the image as `vaubaan-gateway:local` (needs Docker).                              |
| `npm run docker:smoke`  | Starts that image and checks that it boots and refuses an incomplete configuration.      |

The browser tests need Chromium once:

```bash
npx playwright install chromium   # add --with-deps on a fresh Linux machine
npm run test:e2e:v5
```

They start their own instance on port 3105 and the one after it;
`E2E_V5_PORT=<port>` moves both. They use a simulated identity provider and a
simulated provider, like every other test.

**No test ever calls a real provider**, and none needs a credential. A test
that would is refused in review.

A pre-commit hook checks lint and formatting on the files you stage. It is
fast on purpose and does not run the tests: run `npm run ci` before you push.
CI runs the same gate, then the browser tests and the image build.

## Repository layout

```
apps/gateway/            the application: server and web interface    @vaubaan/gateway-app
packages/shared/         shared types and helpers                      @vaubaan/shared
packages/policy-engine/  slices, matching, the risk decision, the validity rule of a budget  @vaubaan/policy-engine
packages/plugin-sdk/     the plugin contract, registry and test kit    @vaubaan/plugin-sdk
packages/gateway-core/   call pipeline, decisions, refusals, audit     @vaubaan/gateway-core
packages/telemetry/      opt-in telemetry report                       @vaubaan/telemetry
plugins/<provider>/      one provider plugin per folder                @vaubaan/plugin-<provider>
plugins/_template/       the scaffold for a new plugin                 @vaubaan/plugin-template
deploy/                  Dockerfile, Compose file, example configuration
docs/                    specification, decisions, handbooks, test plans, workflow
```

These are npm workspaces (`apps/*`, `packages/*`, `plugins/*`). A plugin
imports the SDK only, never the application nor another package: a lint rule
on `plugins/**` refuses it, tests included. The layout is decided in the ADR
[repository-layout-and-contribution-workflow](docs/decisions/repository-layout-and-contribution-workflow.md).

## The documentation comes first

In this project the documentation is part of the change, and it is written
**before or with** the code, never after. A pull request whose code and
documentation disagree is not merged.

| Folder                               | What it holds                                                                                           | When you touch it                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`docs/spec/`](docs/spec/)           | **What** the product does and **why**, independent of the technology. The functional source of truth.   | A change of behaviour starts here. Open an issue first: the specification is discussed before any code. |
| [`docs/decisions/`](docs/decisions/) | **Decisions** (ADRs): one file per choice, with Context, Decision, Consequences, Rejected alternatives. | Any choice somebody could question in six months: a library, a public contract, a structural change.    |
| [`docs/handbook/`](docs/handbook/)   | **How the code works today**, one file per subsystem and one per provider plugin.                       | Whenever you change the code a handbook describes.                                                      |
| [`docs/tests/`](docs/tests/)         | The integration and end-to-end scenarios.                                                               | When you add or change a scenario.                                                                      |
| [`docs/workflow/`](docs/workflow/)   | CI, branches, releases.                                                                                 | When you change the pipeline or the tooling.                                                            |

The order of work:

1. **Read** the part of the specification your change touches
   ([`docs/spec/vaubaan-gateway.md`](docs/spec/vaubaan-gateway.md) is the
   place to start), the decisions that constrain it, and the handbook of the
   code you will modify.
2. **Fill the gaps first.** If the specification is silent on what you want
   to change, open an issue instead of coding around it. If you are about to
   make a real choice, write the ADR.
3. **Code and test.**
4. **Update the documentation in the same pull request**: the handbook says
   what the code does now.

Three rules about these documents:

- An **ADR states the decision in force.** When the decision changes, rewrite
  the file and add one dated line to its `## History` section; a decision
  replaced by another is deleted and summarised in one History line of its
  successor. Name the file after the decision (`docs/decisions/<slug>.md`, no
  number), with `status: accepted` and the date in its frontmatter.
- A **handbook** starts with a `tracks:` list in its frontmatter: the source
  files it describes. Keep it complete; it is what lets a drift check compare
  the document with the code.

## English only

Code, comments, commit messages, documentation, issues and pull requests are
written in English. A few v4 decisions still in force are in French; they
are not a model to follow.

## Rules the code follows

They are checked in review, and several by tests:

- **No hard-coded configuration.** No URL of an instance, no secret, no
  project or account identifier in the code. Configuration comes from the
  environment or the mounted file and a missing key fails at start, naming
  the key. The public API address of a provider inside its plugin is not
  configuration.
- **One list of providers.** The plugin registry is the only list; nothing
  else enumerates providers.
- **Never a wildcard in what is granted.** Accepted risks, share restrictions
  and macro-actions are explicit lists of risk identifiers. "Allow all" is the full
  list, written out.
- **Fail closed.** What cannot be classified, verified or parsed is refused.
- **Tests beside the change.** Unit tests next to the code; integration tests
  on the in-memory store; no network.
- **Strict TypeScript**, no `any`, no cast on data that comes from outside.

## Branches, commits and pull requests

- Fork the repository and create a branch from the branch you target:
  `feat/<short-name>` for a feature, `fix/<short-name>` for a fix.
- **Target branch.** `main` is the trunk: open your pull request against
  `main`. Nothing is pushed to it directly; a release is a tag on it.
- **One feature or one fix per pull request.** A refactoring that is not
  needed by the change goes in its own pull request.
- **Commit messages** follow
  [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(plugin-github): …`, `fix(policy-engine): …`, `docs: …`, `test: …`,
  `chore: …`. Pull requests are squash merged, so the pull request title
  follows the same form.
- Add an entry to [`CHANGELOG.md`](CHANGELOG.md) under `## [Unreleased]` when
  the change is visible to a user, an operator or a plugin author.
- Rebase on the target branch before asking for review; `npm run ci` green.

### Pull request checklist

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) carries this
list; every line is either done or explained.

- [ ] **Specification** — the change does not alter what the product does, or
      the specification change was agreed in an issue first.
- [ ] **Decision** — every non-trivial choice has an ADR.
- [ ] **Handbook** — the handbook of each subsystem touched describes the code
      as it is now, and its `tracks:` list covers the files changed.
- [ ] **Tests** — unit tests beside the code; new scenarios listed under
      `docs/tests/`; no test calls a real provider.
- [ ] **English** everywhere.
- [ ] **No hard-coded configuration**, no second list of providers, no
      wildcard in a risk list.
- [ ] **`npm run ci` is green** locally.
- [ ] **CHANGELOG** entry when the change is user-visible.
- [ ] For a plugin or a catalog: the extra lines of the template (test kit,
      versions, handbook, documentation the classifier was written from).

### Review

A maintainer reviews every pull request. Expect questions on the three things
this project is strict about: the classification of calls (an error there is
a security hole), the documentation matching the code, and the tests. The
project does not commit to a review delay at this stage.

## Plugins and risk catalogs

A plugin's risk catalog (`plugins/<provider>/src/risk-catalog.yaml`) is a
security statement: it names what an agent's call can put at risk and what a
mission creator is asked to accept. It is reviewed like code.

- **To write a new plugin**: open a "Plugin request" issue, then follow
  [`plugins/README.md`](plugins/README.md).
- **To report a wrong or missing risk**: open a "Catalog correction" issue.
  Say which tool call is concerned, how it is classified today and how it
  should be, with a link to the provider's documentation.
- **To change a catalog yourself**: the rules are in
  [`plugins/README.md`](plugins/README.md#changing-an-existing-plugin-or-its-catalog).
  In short: a risk identifier is never renamed or deleted (it is deprecated),
  every reviewed change bumps `catalog_version`, the classifier test that
  proves the change comes with it, and the provider handbook under
  `docs/handbook/providers/` is updated in the same pull request.
- **If the gap lets a mission do more than it accepted** (a write classified
  as a read, a call that escapes its resource), it is a vulnerability: report
  it privately, as below, not in an issue.

## Reporting bugs and proposing features

Use the issue templates: bug report, feature request, plugin request, catalog
correction. Before proposing a feature, check that the specification does not
already cover it or rule it out (section 1.1, "Explicitly out of scope").
Remove tokens, keys and credentials from anything you paste; a token prefix
is enough to identify a mission.

## Security issues

Do not open a public issue for a vulnerability. Report it privately through
GitHub's security advisories: the "Security" tab of the repository, "Report a
vulnerability". What is in scope, what to include and what to expect is in
[`SECURITY.md`](SECURITY.md).

## Licence

The project is licensed under [Apache-2.0](LICENSE). As that licence states
(section 5), a contribution you submit for inclusion is provided under the
same licence. The project has not yet stated whether it will also ask for a
contributor licence agreement or a sign-off on commits; until this page says
so, neither is required.
