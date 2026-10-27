---
title: Demo mode
tracks:
  - apps/gateway/tests/demo/
  - apps/gateway/tests/integration/demo/
  - apps/gateway/tests/integration/auth/fake-idp.ts
  - packages/plugin-sdk/src/catalog-path.ts
last_reviewed: 2026-10-27
---

# Demo mode — handbook

`npm run demo`: the real application on `http://localhost:3210`, a simulated
identity provider, simulated services, seeded data; nothing leaves the
machine. Anybody who reaches it signs in as anybody: a development tool, never
deployed.

## Start here

- [`main.ts`](../../apps/gateway/tests/demo/main.ts) — the command: guards, build, global `fetch` guard, start, tour (`DEMO_PORT`, `DEMO_KEEP`, `DEMO_SKIP_BUILD`).
- [`demo-instance.ts`](../../apps/gateway/tests/demo/demo-instance.ts) — `startDemo()`: in-memory configuration, the composition root through its existing `RootDeps`, seed, then Next.
- [`providers.ts`](../../apps/gateway/tests/demo/providers.ts) — every simulated provider route.
- [`seed.ts`](../../apps/gateway/tests/demo/seed.ts), [`people.ts`](../../apps/gateway/tests/demo/people.ts), [`tour.ts`](../../apps/gateway/tests/demo/tour.ts) — who signs in, what exists, what the command prints.

## Invariants

- **Nothing under `apps/gateway/src/` knows the demo**: no flag, option or variable; only pre-existing injection points of the root are used. Held by `demo-safety.test.ts`, which also checks that no `tests/` file is in `.next/standalone` and no built file names `/__demo`.
- **The launcher refuses a real environment**: `NODE_ENV=production`, `VAUBAAN_CONFIG_FILE` or `VAUBAAN_PUBLIC_URL` set → exit 2 before anything opens (`guards.ts`).
- **Nothing leaves the machine**: the listener binds `127.0.0.1`; provider calls go to `providers.ts`; telemetry and client-document fetches refuse; the global `fetch` refuses any non-loopback host; SSH is not registered.
- **The seed writes nothing to the store directly**: sign-ins, connections, shares, missions, the OAuth handshake and the calls all go through the application's handlers and services, so every seeded state is one the application can reach. The surface rate limits are lifted while it runs only.
- **No lasting secret or data**: keys generated per run, the SQLite file in a `mkdtemp` directory deleted on exit unless `DEMO_KEEP=1`.

## Traps

- The configuration loader accepts https only and is **not** changed: the demo loads an https placeholder, then sets `http://localhost:<port>` on the typed result. That URL is the public URL, the redirect URI and the origin every form is checked against — open exactly `http://localhost:<port>`.
- The session cookie is `Secure`, as on a real instance: Safari refuses it on `http://localhost`; use Chrome or Firefox. From another machine, forward the port with `ssh -L`.
- The plugins' computed catalog path made Next trace all of `apps/gateway`, fixtures included, into the standalone output; `catalogPathNextTo` marks it ignored by the tracer. Do not compute that path another way.
- The build stamp (`build-stamp.ts`) hashes the contents of the build inputs, not dates: a build made by anything else has no stamp and is rebuilt once.
- Upstash database hosts sit under the plugin's pinned REST suffix because the plugin posts a database token to no other host.
- Settings → Setup and `/healthz` say `dev` while the footer shows the stamped version: the demo composes the root in its own process, outside the built application.
- Simulated answers are canned (a write changes nothing a later read shows); Supabase and Railway accept a well-shaped token but answer no call; Gmail cannot connect; SSH is absent.

## Procedures

- **Add a simulated endpoint**: one route in `providers.ts`, the URL read off the plugin that calls it.
- The browser tests' ephemeral instance ([`ephemeral-instance.ts`](../../apps/gateway/tests/e2e/v5/ephemeral-instance.ts)) is the same construction on the standalone `server.js`; keep the two in step.

## Debug

- **`The demo refuses to start`** (exit 2) → a `VAUBAAN_*` variable or a busy port; use a clean shell or `DEMO_PORT`.
- **Sign-in loops back to `/login`** → Safari, or the page opened as `127.0.0.1` or another port.
- **`no simulated answer for <METHOD> <URL>`** → add the route; nothing was sent.
- **A page shows an error** → `DEMO_KEEP=1 npm run demo`, read `gateway.log` in the printed directory.
- **Stale pages** → `DEMO_SKIP_BUILD=1` serves whatever is built; delete `apps/gateway/.next/demo-build-stamp` to force a build.
- **A connect attempt is rate-limited** → the real per-user limit applies after the seed.
