---
title: GitHub sign-in — OAuth web flow with PKCE, the numeric id as subject, the primary verified email, teams read only for the admin rule
status: accepted
date: 2026-10-13
extends:
  - sign-in-providers-admission-and-admin-rule
---

# GitHub sign-in — OAuth web flow with PKCE, the numeric id as subject, the primary verified email, teams read only for the admin rule

> First real use of several providers: the dogfooding instance signs in with
> GitHub. GitHub is not an OpenID Connect provider for people (no ID token, no
> discovery). Handbook: [authentication](../handbook/authentication.md).

## Context

The relying party (`openid-client`) needs discovery and an ID token; GitHub
offers neither to an OAuth App. Its web flow gives an access token, and the
identity is read from the REST API. A GitHub **login** can be renamed, and a
released login can be taken by somebody else. GitHub lists several addresses
per account, each verified or not. Team membership needs `read:org`, a scope
that frightens people when it is not needed.

## Decision

- **Kind `github`.** Authorization at `<issuer>/login/oauth/authorize` with
  `client_id`, the provider's own callback (`/auth/callback/<id>`), `state`,
  a PKCE S256 challenge (GitHub supports PKCE for OAuth Apps), and
  `allow_signup=false`; the code is exchanged at
  `<issuer>/login/oauth/access_token` with the client secret and the verifier.
  The response's `state` is compared in constant time with the attempt's.
- **Subject = the numeric user id** (`GET /user` → `id`), never the login.
  Issuer = the provider's base URL: `https://github.com` by default (the REST
  API is then `api.github.com`), or a **GitHub Enterprise Server** base URL
  (`<base>/api/v3`) — supported because it costs one derived URL.
- **Email = the primary address of `GET /user/emails`, refused unless GitHub
  verified it** (`email-not-verified`), and refused when there is none. Another
  verified address is not taken instead: the primary one is what the person
  chose to be reached at.
- **Scopes: `read:user user:email`**, plus `read:org` only when the admin rule
  names a team of this provider. Then, and only for that team (`org/team`),
  `GET /orgs/<org>/teams/<team>/memberships/<login>`: `state: active` is a
  member, 404 is not, anything else is unknown and refuses the sign-in
  (`groups-unavailable`) rather than reading "not a member". The team becomes
  an IdP group of the provider (`groups.provider = <id>`); no other team is read.
- **The token is dropped** once the identity is read; nothing of it is stored.
- A GitHub provider is **open** (anyone can open an account): it needs allowed
  domains or "invitation only".
- How to register the OAuth App (the callback URL is shown before the client id
  is asked) is in [deploy/railway.md](../../deploy/railway.md) and on the "Add
  GitHub" page.

## Consequences

- People sign in with their own GitHub account; renames do not change who they
  are on the instance.
- A person whose primary address is unverified at GitHub is told to verify it.
- An organisation that restricts OAuth App access must approve the App for the
  team check to work; until then administrators named by a team cannot sign in
  (the refusal says to retry and the log names the cause); `admin.emails`
  still works.

## Rejected alternatives

- **A GitHub App instead of an OAuth App.** Its user tokens cannot ask for
  `read:org` as a scope (permissions are fixed on the App) and the instance
  already uses a GitHub App for connections, which would mix two roles in one
  registration. An OAuth App is the documented "Sign in with GitHub".
- **The login as subject.** Renamable and reusable: an identity takeover.
- **Any verified address.** It would let a person pick the address that passes
  the domain rule rather than the one they use.
- **Reading every team and syncing them as groups.** It needs `read:org` for
  everybody and imports groups the instance has no use for.
- **Revoking the GitHub token after the sign-in** (`DELETE
/applications/<client_id>/token`). Desirable hygiene, one more call that can
  fail; not done yet (the token is never stored, and expires with GitHub's own
  policy).
