---
title: Sign-in hardening — `__Host-` cookies, group overage refused, the IdP secret asked again when the issuer changes
status: accepted
date: 2026-10-13
extends:
  - oidc-relying-party-and-web-session
---

# Sign-in hardening — `__Host-` cookies, group overage refused, the IdP secret asked again when the issuer changes

> Three decisions of P3.4 on the human sign-in, from the reported-not-fixed
> items of the Phase 1 security review and the Entra ID question of the
> orchestrator's log. Handbook:
> [authentication](../handbook/authentication.md).

## Context

1. **Cookies.** The session and pending sign-in cookies were `vbn_session`
   and `vbn_login`: `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`.
   Nothing stops a **sibling subdomain** from setting a cookie of the same
   name for the parent domain. An instance at `gateway.corp.example` shares a
   registrable domain with every other internal service; whoever controls one
   of them (or finds an XSS there) can plant their own session cookie in a
   colleague's browser. The colleague then works in the attacker's account —
   and connects provider credentials into it.
2. **Group overage.** Entra ID omits the groups claim from a token once the
   user is in more than 200 groups and sends `_claim_names` /
   `_claim_sources` (or `hasgroups: true`) instead. `parseGroupsClaim` read
   the absent claim as "no groups" and the sign-in then **replaced the user's
   IdP memberships with nothing**: they lost ownership of group-owned
   connections, shares made to their groups and possibly the admin rule, and
   their missions turned `orphaned`. Since `orphaned` is derived, the damage
   was reversible, but it was silent and looked like a permission bug.
3. **Issuer change.** The identity-provider form keeps the stored client
   secret when the field is left blank. It did so also when the **issuer**
   changed, so the secret of one IdP was sent to the token endpoint of
   another.

## Decision

1. **Both cookies carry the `__Host-` prefix**: `__Host-vbn_session`,
   `__Host-vbn_login`. A browser accepts such a cookie only with `Secure`,
   `Path=/` and no `Domain`, set by the host itself, so a sibling subdomain
   cannot write it. `serializeCookie` and `clearCookie` refuse a `__Host-`
   name on another path rather than emit a cookie the browser would drop.
   The reader holds the other half: `readCookie` matches the name exactly
   (never `trim()`, which would equate `\u00a0__Host-vbn_session` — a name a
   browser lets a sibling subdomain set — with the session cookie), and a
   name present twice in the header is no cookie. Found by the security
   review of this very change.
2. **A token whose groups were moved out is refused**, with the closed code
   `groups-overage`, before anything is written: no user row, no group sync.
   Detected on the configured groups claim: `_claim_names` naming it, or
   `hasgroups` true when the claim is Entra's `groups`. A partial list next
   to the pointer is refused too. The user reads why and that the operator
   must act; the log line names the claim and the remedy ("Groups assigned
   to the application" in the app registration's token configuration, or
   another claim).
3. **A blank secret is kept only for the same issuer.** When the issuer
   changes, the form requires the secret of the new one.

## Consequences

- Every session open at the upgrade ends: the old cookie name is not read.
  Users sign in again once. In-flight sign-ins (`vbn_login`) restart.
- `__Host-` needs the instance at the **root path of its own host** — already
  what `public_url` (https) and the single-origin rule give. Chromium and
  Firefox treat `http://localhost` as secure for this purpose, which is what
  the demo uses (checked in Chromium: the prefixed cookie is stored and sent
  back on `http://localhost` and `http://127.0.0.1`); the Playwright suite
  goes through an https origin. Plain `http` on any other host never worked
  (`Secure`), and Safari refuses `Secure` cookies on `http://localhost` with
  or without the prefix.
- An Entra ID user above the overage threshold cannot sign in until the
  operator narrows the claim. That is a deliberate, loud refusal in place of
  a silent loss of authority; existing sessions and memberships are untouched
  by the refused attempt.
- The instance still does not call the Graph API: it would need a permission
  and a credential of its own, for one IdP.
- An operator who moves to another issuer must have its client secret at
  hand; moving between two issuers that share a secret is typed twice.

## Rejected alternatives

- **`__Secure-` prefix.** It requires `Secure` only; a sibling subdomain can
  still set it for the parent domain.
- **Signing or encrypting the cookie value.** The value is already a 256-bit
  random id looked up by its digest; the attack plants a _valid_ session of
  the attacker, which no signature distinguishes.
- **Follow `_claim_sources`** (fetch the groups from the Graph endpoint). An
  outbound call per sign-in with the user's access token and a Graph
  permission the operator must grant; Entra-specific code in the sign-in
  path. The remedy at the IdP is one setting.
- **Keep the previous memberships when the claim is missing.** A user removed
  from every group at the IdP sends the same token as one whose IdP sends no
  groups: "missing" would then mean "unchanged" and removals would never
  apply. Only the explicit overage markers are refused.
- **Refuse the form whenever the secret is blank.** The form never echoes the
  secret; requiring it for every edit of a claim name trains operators to keep
  it in a clipboard.
