---
title: Security headers set by the application — nonce CSP through the Next proxy; the reference reverse proxy sets none
status: accepted
date: 2026-10-13
extends:
  - docker-image-and-config-format
---

# Security headers set by the application — nonce CSP through the Next proxy; the reference reverse proxy sets none

> Platform hardening for deployments without the reference Caddy (Railway's
> edge, a cloud load balancer). Handbooks:
> [configuration](../handbook/configuration.md),
> [threat model](../handbook/threat-model.md).

## Context

The security headers were set by `deploy/caddy/Caddyfile` only: HSTS,
`nosniff`, `Referrer-Policy: same-origin` and a Content-Security-Policy that
restricted framing only. A deployment behind another proxy — Railway, the
first real one — had none of them, and no deployment restricted scripts.

## Decision

- **`src/proxy.ts`** (the Next 16 request hook, Node runtime) sets, on every
  response, the headers of `server/http/security-headers.ts`:
  - a `Content-Security-Policy` (below) whose nonce is handed to Next through
    the request's own policy header; Next puts it on the scripts it renders
    (every page is rendered per request: the root layout reads the theme
    cookie);
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: same-origin` (not `no-referrer`: the origin check falls
    back on `Referer`), `Permissions-Policy` granting no device;
  - `Strict-Transport-Security: max-age=31536000` when the public URL is https
    (the root publishes the fact at boot; the proxy imports nothing of it).

  ```
  default-src 'self'; script-src 'self' 'nonce-<per request>' 'strict-dynamic';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none';
  frame-ancestors 'none'
  ```

- **No `form-action`.** Chrome applies it to the redirects after a form post,
  and a sign-in, the connect flow of an account and an OAuth consent answer are
  posts that end at another origin chosen at run time.
- **The OAuth consent documents keep their own, stricter policy**
  (`default-src 'none'` and the nonce of their one style element): the proxy
  leaves `/oauth/authorize/**` alone, so no second policy is added to theirs.
- **One source.** The Caddyfile no longer sets any of these headers (two
  policies are enforced together; two `X-Frame-Options` values can read as
  invalid). A structural test holds both: only the module, the proxy and the
  consent documents write a CSP, and the Caddyfile names none of the headers.
- **The sign-in buttons are plain links**, never prefetched by the framework:
  a prefetched `/auth/login/<id>` would start a sign-in on page view.

## Consequences

- Every deployment has the headers; the smoke test asserts them on the image
  alone, without a proxy.
- An injected inline script does not run; a style attribute does (React
  renders them; a nonce cannot cover an attribute).
- `next dev` adds `'unsafe-eval'` (development only).

## Rejected alternatives

- **Static headers in `next.config.ts`.** No nonce is possible there, so
  `script-src` would need `'unsafe-inline'`; and HSTS would not follow the
  public URL, frozen at build time.
- **Keeping the headers in Caddy as well.** Duplicates that browsers combine
  (CSP) or may reject (`X-Frame-Options`), and two places to change.
- **Hashes instead of a nonce.** Next's inline scripts change per render.
