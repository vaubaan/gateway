---
title: One image runs one Next.js standalone process; every endpoint is a route handler over host-agnostic server code
status: accepted
date: 2026-10-13
---

# One image runs one Next.js standalone process; every endpoint is a route handler over host-agnostic server code

## Context

The gateway ships as one Docker image holding the Node server and the Next.js interface. Next's
`output: 'standalone'` excludes a custom server, yet the MCP doors, the OAuth server, the sign-in
callbacks and `/healthz` are not UI, and the shape must not preclude horizontal scaling later.
Every surveyed self-hosted Next.js project runs the standalone server as its only process.

## Decision

The image runs `node apps/gateway/server.js`: one container, one process, one listener behind the
company's TLS terminator. Every non-UI endpoint is an App Router route handler on the Node runtime
returning web-standard streamable `Response`s, and `apps/gateway/src/server/**` never imports
`next`: route handlers are one-line adapters. One composition root is built once and reached
through `getRoot()`; configuration is read only by `src/server/config/`.

## Consequences

- An incomplete configuration stops the container with exit 78 naming every missing key.
- A `process.env` read outside `src/server/config/` is a review defect (inlined `NEXT_PUBLIC_*`
  stamps excepted); features read `GatewayRoot.config`.
- In-memory port implementations are marked `// single-process only`; horizontal scaling means a
  Postgres store, a shared rate limiter, cache and sessions, not a change to the doors.
- Configuration keys and precedence (file over environment, key by key): handbook
  [configuration](../handbook/configuration.md).

## Rejected alternatives

### A custom Node/Hono/Express server embedding Next

Gives up the standalone output (images of 0.5-1.5 GB) and depends on internals that change across
majors.

### Two listeners or two processes in one container

Breaks "one port behind the TLS terminator"; a supervisor doubles health checks, logs and shutdown.

### A separate API server with the UI as a static SPA

Two deploy units for a single-tenant self-hosted product.
