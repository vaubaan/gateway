---
title: The demo mode is the real application on localhost, composed from the test tree, and never part of the image
status: accepted
date: 2026-10-13
extends:
  - docker-image-and-config-format
  - oidc-relying-party-and-web-session
  - plugin-catalog-path-and-standalone-tracing
---

# The demo mode is the real application on localhost, composed from the test tree, and never part of the image

> Decided while building `npm run demo` (handbook [[demo-mode]]), so that the
> product owner can click through the whole interface without registering an
> OIDC client or a provider app.

## Context

The human surface of v5 can only be opened behind an identity provider, and is
empty until a provider is connected through an app the company registered at
that provider. Trying the interface therefore costs an OIDC client, a GitHub
App, API keys and a TLS terminator, before the first page shows anything.

The browser tests already solve the same problem for a robot
(`tests/e2e/v5/ephemeral-instance.ts`): the real composition root on a
`:memory:` store, an in-process identity provider handed to the relying party
as its `fetch`, a mocked GitHub as `RootDeps.providerFetch`. A human browser
cannot use it: its public origin is an https host that does not resolve, which
Playwright reaches by intercepting requests.

Three constraints frame the answer:

- the configuration loader accepts an https `public_url` only, and cookies are
  `Secure`; neither may be weakened for a demo;
- a mode in which anybody signs in as anybody must not exist in the image, nor
  be startable next to a real configuration;
- no provider may be called ("no integration test against a real provider,
  ever" applies to a demo all the more).

## Decision

### D1 — The demo is the real root, composed by a launcher under `tests/`

`apps/gateway/tests/demo/` builds the composition root through `getRoot(deps)`
with the injection points that already exist (`loadConfig`, `buildRegistry`,
`oidc`, `providerFetch`, `telemetryFetch`, `clientDocumentFetch`,
`rateLimiter`, `logWrite`) and serves the built Next application on it. No
file under `apps/gateway/src/` knows the demo; no option, flag or environment
variable of the application enables it.

### D2 — The public URL is `http://localhost:<port>`, set on the typed configuration

Chrome and Firefox treat `http://localhost` as a secure context and accept
`Secure` cookies there, so the application runs unmodified. The launcher calls
`loadInstanceConfig` with an environment of its own and an https placeholder,
then sets `publicUrl` on the typed result, as a test builds a configuration.
The loader keeps refusing anything but https. Safari does not accept the
cookie; the handbook says so.

### D3 — The identity provider is `FakeIdp`, published over HTTP on the same listener

`DemoIdp` extends the suite's `FakeIdp` and serves it under `/__demo/idp/`.
The relying party discovers it and exchanges codes over HTTP, with
`allowInsecureIssuer` (the option the tests already use). Its authorize page
is an account picker with three people and no password. `/login`,
`/auth/login` and `/auth/callback` are the application's.

### D4 — Providers are answered by one `fetch`; an unmatched request fails

`createDemoProviders()` answers GitHub, Stripe, Cloudflare DNS, Resend and
Upstash Redis from memory and throws on anything else. The demo's registry is
the shipped plugins with two differences: GitHub's `installUrl` points at a
simulated installation page on the listener (a real browser must not be sent
to github.com), and the SSH plugin is left out (its calls open connections
instead of going through `fetch`). The command additionally replaces the
global `fetch` with one that refuses every host but the loopback.

### D5 — Data is seeded through the application's own code paths

`seedDemo` signs each person in through the real handlers, connects through
`ConnectionService`, issues through `MissionService` and the management door,
and spends quotas by calling the execution door. Nothing is written to the
store directly, so the demo cannot show a state the application cannot reach.

### D6 — Guards: not in the image, not next to a real instance, not on the network

- The launcher refuses `NODE_ENV=production` and a shell where
  `VAUBAAN_CONFIG_FILE` or `VAUBAAN_PUBLIC_URL` is set.
- The listener binds `127.0.0.1`; another machine reaches it with `ssh -L`.
- The master key, the GitHub App key pair and every secret are generated per
  run; the SQLite file lives in a `mkdtemp` directory deleted on exit.
- `tests/integration/demo/demo-safety.test.ts` fails if a file of `tests/`
  reaches `.next/standalone`, if a built file names `/__demo`, or if something
  under `src/` names the demo.

### D7 — The plugins' catalog path is hidden from the bundler's tracing

Holding D6 revealed that the standalone output already contained the whole
`apps/gateway` directory — `tests/` with its password-less identity provider
included. Cause: `catalogPathNextTo` builds a path from `import.meta.url`,
which Turbopack reports as "dynamic filesystem access" and answers by tracing
the entire project into the output. The `join` call now carries
`/* turbopackIgnore: true */`. The catalogs are unaffected: they are traced by
name through `outputFileTracingIncludes`
([[plugin-catalog-path-and-standalone-tracing]] D2), and
`standalone-plugin-catalogs.test.ts` still holds that.

## Consequences

- `npm run demo` is one command; it builds first (`DEMO_SKIP_BUILD=1` skips).
- The demo follows the application for free: a new page, handler or check is in
  the demo at the next build. It follows the providers only as far as
  `providers.ts` simulates them; a new tool endpoint needs a route there.
- The standalone output shrinks to what the server needs: no `tests/`, no
  `next.config.ts`, no `tsconfig`. The image is built from it unchanged.
- The demo depends on test fixtures (`FakeIdp`, `mockFetch`): changing them can
  break it. The smoke test runs the command in `npm run ci` and catches that.
- A simulated provider answers canned payloads: the demo shows the gateway's
  behaviour (decisions, budgets, requests, audit), not a provider's.
- The application's pages carry no "demo" marking, being unmodified; the banner
  is on the terminal, the account picker and the installation page.

## Rejected alternatives

### A `demo` flag in the application

`VAUBAAN_DEMO=1` switching the root to fakes would put a password-less sign-in
and mocked providers in the image, one environment variable away from a
production instance. Rejected: the safest demo code is the one that is not
shipped.

### Accept `http://localhost` in the configuration loader

Would let the standalone server itself run the demo configuration. It also
lets a real instance be configured without TLS by mistake, and the loader's
https rule is what the `Secure` cookies and the origin check rely on.
Rejected; the launcher sets the URL on the typed object instead.

### A self-signed certificate on localhost

Keeps https everywhere, at the price of a certificate warning in the first
second of the demo and of a trust-store step for `curl`. Rejected: loopback is
already a secure context for the two browsers the handbook names.

### Keep the identity provider in-process, as the browser tests do

The relying party would not need HTTP, but the browser needs an authorize page
it can reach, so a listener route is required anyway. Serving the whole
provider there keeps one path for both and shows the real discovery.

### Seed with SQL or through the repositories

Faster to write, and able to produce states the application never produces
(a claim without the refused call that opened it, a session without events).
Rejected: the demo is also what somebody reads the application's behaviour
from.

### A separate workspace for the demo

Would keep it out of `apps/gateway` altogether, at the cost of a package, a
tsconfig reaching into another workspace's sources and a lockfile change.
Rejected once the tracing was fixed at its cause (D7): `tests/` is the place
for code that composes the root with fixtures.

## References

- Handbook : [[demo-mode]] ; [[plugin-sdk]] ("Catalog path").
- Code : `apps/gateway/tests/demo/`, `apps/gateway/tests/integration/demo/`,
  `packages/plugin-sdk/src/catalog-path.ts`.
- Related : [[docker-image-and-config-format]] (standalone output),
  [[oidc-relying-party-and-web-session]] (the sign-in that runs unchanged).
