---
title: One switch, VAUBAAN_LOCAL, runs an instance for this computer alone — http on loopback only, its own setup link, a session cookie without Secure
status: accepted
date: 2026-11-24
author: Renaud Pelissier
---

# One switch, VAUBAAN_LOCAL, runs an instance for this computer alone — http on loopback only, its own setup link, a session cookie without Secure

## Context

One person must start an instance with one `docker run`, and the desktop app runs the same server
([desktop-app-tauri-shell-over-the-node-standalone-server](./desktop-app-tauri-shell-over-the-node-standalone-server.md)).
An instance asked for an https public URL, a bootstrap token, a source of client addresses and a
key file kept apart from the store: four decisions a person on a laptop cannot make. Safari and
WKWebView refuse a `Secure` cookie on `http://localhost`, so the session cookie would never reach
the desktop app on a Mac.

## Decision

`local: true` (`VAUBAAN_LOCAL`) is the only way an instance accepts an `http` public URL, and then
only on a loopback host; it supplies what the person would have had to choose (public URL
`http://localhost:3000`, store and generated key under `/data`, shared address windows) and every
key stays overridable. Without a configured bootstrap token it makes a new one at each start and
prints the setup link, token in the fragment, to its standard output until the setup is finished.
Its cookies drop `Secure` and the `__Host-` prefix and keep `HttpOnly`, `SameSite=Lax`, `Path=/`.

## Consequences

- Nothing else infers the mode: an `http` public URL without `local` stays a configuration error,
  and `local` with a host other than loopback is one too.
- Code that depends on the mode reads `config.local`, never the URL's scheme; HSTS keeps following
  the scheme.
- The interface says the instance is meant for this computer; the run command publishes the port
  on `127.0.0.1`, which the process cannot check from inside its container.
- The key shares the volume with the store: the setup's key download is the only copy apart.

## Rejected alternatives

### Infer the mode from an `http://localhost` public URL

A typo or a copied example would change the security model without anyone having said so.

### No bootstrap token on loopback

A port published on every interface (`-p 3000:3000`) would let anyone on the network claim the
instance first.

### Keep the `Secure` cookie and serve the desktop app over local TLS

A certificate trusted by the system for `localhost` is installed with administrator rights and
must be renewed; Chrome and Firefox users of the docker command gain nothing.

## History

- 2026-11-27: a local instance signs in with Google, Microsoft and GitHub and connects their services through installed-app clients it carries ([local-instance-carries-installed-oauth-clients](local-instance-carries-installed-oauth-clients.md)).
