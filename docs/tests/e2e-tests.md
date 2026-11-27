---
title: E2E test plan
tracks:
  - apps/gateway/tests/e2e/playwright.config.ts
  - apps/gateway/tests/e2e/ephemeral-instance.ts
  - apps/gateway/tests/e2e/instance.ts
  - apps/gateway/tests/e2e/browser.ts
  - apps/gateway/tests/e2e/agent.ts
  - apps/gateway/tests/e2e/mission-pages.ts
  - apps/gateway/tests/manual/
  - deploy/docker/smoke.sh
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
last_reviewed: 2026-11-15
---

# E2E test plan

## Scope

- The acceptance criterion is manual: the instance owner, on their own instance behind TLS with their own IdP, services and Claude Code, connects every service, issues one mission per code project and works a day with **no unexpected refusal** (spec [§10](../spec/vaubaan-gateway.md#10-tests) "End to end"; checklist in handbook [first-install](../handbook/first-install.md)). Everything automated exists to make that run boring.
- Automated, and never touching a real IdP, service or coding agent: the browser specs (`npm run test:e2e`), among them `cutover-smoke.spec.ts` walking the acceptance path in-process; and the container smoke (`deploy/docker/smoke.sh <image>`, `npm run docker:smoke`), which proves the image boots from configuration, runs as non-root and ships no test file.
- Nothing automated runs the application path inside the image: the browser suite runs the shipped standalone `server.js`, the container smoke stops at boot, configuration and operator commands.
- Cross-module behaviour without a browser is in [integration-tests.md](./integration-tests.md).

## Stack

- Playwright, one config (`apps/gateway/tests/e2e/playwright.config.ts`); not part of `npm run ci`. In CI the `e2e` job runs weekly, on a manual run, in the release gates, and on a pull request only when it carries the label `e2e` (put it on a change to pages, components, styles, the mission form or a plugin's catalog).
- `webServer` is `ephemeral-instance.ts`: the real composition root (`testRootDeps`, `:memory:` store, shipped plugins) served by the shipped standalone `server.js` as the Dockerfile runs it, so a file the build fails to trace fails the suite.
- Fakes enter through `RootDeps` only: `FakeIdp` as the relying party's `fetch`, a mocked GitHub (`mockFetch`) as `serviceFetch`, `FakeGithubHost` for the git remote spec's repository. Any other outbound request rejects.
- `public_url` is `https://gateway.e2e.test`, routed by `browser.ts` to the local listener so cookies stay `Secure` and the origin check sees the public origin; redirects are answered as navigating pages (Playwright does not route redirect hops).
- Listeners keep idle sockets 180 s (`IDLE_SOCKET_MS`): Playwright reuses connections without retrying a reset, and Node's 5 s default gave `socket hang up`.
- Manual scripts live in `apps/gateway/tests/manual/`: `seed-demo.ts` (a throw-away instance with a kit) and `streaming-check.ts` (`serve` then `probe`; exits non-zero when progress frames arrive together). Rerun the streaming check after a change of Next.js, the MCP SDK, `next.config.ts` or the proxy configuration, also behind the pinned Caddy of `deploy/caddy/`.

## Conventions

- Specs are `apps/gateway/tests/e2e/*.spec.ts`; the helpers beside them (`agent.ts`, `browser.ts`, `instance.ts`, `mission-pages.ts`) are shared by every spec.
- The mission screen is driven through `mission-pages.ts`: `addAccount` / `includeWithTrustLevels` ("+ Add an account", then step 2), `pickTrustLevel`, `openCustom` / `allowOnly` (the Custom modal). A card is named as its controls name it — `GitHub · acme-org`, with its environment in brackets when it shows one (`Supabase · Acme Supabase (prod)`), and found with `cardOf`.
- The app listens on `E2E_V5_PORT` (default 3105) and the control endpoints on the next port only (`controlUrl()`, under `/__e2e`; the app port answers 404 as the image does). Pick another pair when several checkouts run at once.
- The IdP has no default user: each spec names its user with `signInAs` in `beforeEach`, never relies on nor restores another spec's user. Seeded users (`E2E_USER`, `E2E_AUDIT_USER`, `E2E_SHARE_OWNER`, …) are declared in `instance.ts`.
- Every executor call is HTTP on `/mcp` with a mission token through `agent.ts`, so it crosses the real door and budget. Only the `seed-day` control endpoint records below the door (a day of calls no mock answers).
- No spec creates state in a real cloud: there is no dedicated test org and no sweeper; the state dies with the `:memory:` store.
- The ephemeral instance reads no versions feed (`VAUBAAN_UPDATES_CHECK=false`, set in `ephemeral-instance.ts`): no spec reaches vaubaan.com, and Administration › Plugins shows no feed notice there; the notices are a unit test of the view.
- `E2E_V5_SCREENSHOT_DIR=<folder>` keeps a screenshot per step.
- Push in a browser is stubbed at the service worker container (`notifications.spec.ts`): a headless browser on a closed network reaches no push service, so the spec checks the pages and the subscription they post; Chromium is granted the `notifications` permission. The service worker itself is a unit test. The messaging services are a stand-in `RootDeps.notificationFetch` of the ephemeral instance (it answers the status a path ends with, `…/status-404`, 200 otherwise) and mail notifications a `notificationMailer` that sends nothing, while `mail.*` stays unconfigured for the sign-in accounts.
- The container smoke takes `SMOKE_EXPECT_VERSION`, `SMOKE_EXPECT_COMMIT`, `SMOKE_EXPECT_ARCH`; the release sets all three, per architecture, on the built image and again on the pushed digest.
- Manual acceptance: an expected refusal is a limit answered or waited out, a permission a daily-work mission should not hold unattended, an `approval-required` on a gated permission, or a resource left out on purpose. Unexpected (blocks the cutover): a refusal on an action the day needs, an unplaceable call, `risk-not-accepted` on `uncategorized-write`, `account-unavailable` or `mission-inactive` on a healthy account, a v4 tool v5 does not list. Each is fixed in the macro-actions, catalog or code, and the day is run again.

## Known gaps

- ⚠️ **The first-call path is counted from the home, not from the download** (`first-call-path.spec.ts`): the install and the two setup screens of a local instance, a service that signs in instead of taking a pasted key, and the real agents (Claude Code, Codex, Claude Desktop) are walked by hand on a Mac (handbook desktop-app, "Test the first-call path"). The spec stands in for the agent with an MCP client built from the line the page gives.
- ⚠️ **The manual acceptance run** (spec [§10](../spec/vaubaan-gateway.md#10-tests)) — not run yet; it is the instance owner's.
- ⚠️ **Claude Code against a running instance behind TLS** (spec [§4.4](../spec/vaubaan-gateway.md#44-bootstrap-kit-after-issuance)) — never done; the official MCP client stands in. Part of the manual run.
- ⚠️ **Bootstrap, Settings → Sign-in and the instance name in a browser** (spec [§7.1](../spec/vaubaan-gateway.md#71-install-an-instance)) — integration (`FakeIdp`) and by hand only.
- ⚠️ **Real sign-in providers** (spec [§4.2](../spec/vaubaan-gateway.md#42-human-surface)) — Google, Entra, Microsoft personal, a GitHub org restricting OAuth Apps: by hand only, when the feature changes.
- ⚠️ **Future resources joining a card in a browser** (ADR resource-set-is-one-environment-with-optional-future-resources) — `issue-mission.spec.ts` issues two cards of one account (staging and prod) and the edit spec changes a card's resources; "↻ Check now" and a resource joining a future card are integration-only (`future-resources.test.ts`, the accounts service), as is the split of a legacy mixed-environment set on the edit screen (`form-state.test.ts`).
- ⚠️ **The hourly refresh in a browser** (spec [§0](../spec/vaubaan-gateway.md#0-vocabulary) Resource) — `auto-refresh.spec.ts` opens a stale account (control endpoint `stale-account`) and sees a repository appear; the tick, its slots and back-off, the key's check again and the audit rule are unit and integration only (`account-refresh.test.ts`, `auto-refresh.test.ts`). The ephemeral instance sets `accounts.refresh_interval: 24h` and seeded accounts have no last refresh, so no tick and no other spec's page refreshes them.
- ⚠️ **Giving access to a team, approving a registered app, deactivating a person in a browser** (spec [§7.3](../spec/vaubaan-gateway.md#73-give-access)) — integration only.
- ⚠️ **OAuth and SSH connect flows in a browser** (spec [§7.2](../spec/vaubaan-gateway.md#72-connect-an-account)) — only the pasted-token flow runs in a browser; the others are integration-only, and real accounts are checked by hand.
- ⚠️ **A notification on a real phone** (spec [§4.2 bis](../spec/vaubaan-gateway.md#42-bis-notifications)) — installing the interface on an iPhone or Android, the lock-screen notification and its click: by hand only, behind TLS.
- ⚠️ **The application path inside the image** (spec [§4.3](../spec/vaubaan-gateway.md#43-instance-configuration)) — covered only by the manual run.
