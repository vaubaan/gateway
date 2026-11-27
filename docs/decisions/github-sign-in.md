---
title: GitHub sign-in is an OAuth App flow with PKCE; the person is the numeric user id and the primary verified address
status: accepted
date: 2026-10-13
---

# GitHub sign-in is an OAuth App flow with PKCE; the person is the numeric user id and the primary verified address

## Context

GitHub is not an OpenID Connect provider for people: an OAuth App gets an access token and the REST
API, no ID token. A login can be renamed and a released login taken by somebody else; an account
lists several addresses, verified or not; reading teams needs `read:org`, a scope that frightens
people when it is not needed. Users are keyed by (issuer, subject), so the subject chosen now is
permanent.

## Decision

A provider of kind `github` runs the OAuth web flow with `state`, PKCE S256 and `allow_signup=false`.
The subject is the numeric user id, never the login; the email is the primary address of
`/user/emails`, refused unless verified. Scopes are `read:user user:email`, plus `read:org` only
when an administrator designation names a team of this provider, and the token is dropped once
the identity is read.

## Consequences

- Renames do not change who a person is on the instance; a person with an unverified primary
  address is told to verify it.
- Only designated teams are read; an answer other than member or not-member refuses the sign-in
  (`groups-unavailable`).
- A GitHub provider is open: it needs allowed domains or "invitation only".

## Rejected alternatives

### A GitHub App instead of an OAuth App

Its user tokens cannot ask for `read:org`; an OAuth App is GitHub's documented "Sign in with GitHub".

### The login as subject

Renamable and reusable: an identity takeover.

### Any verified address, or every team synced as groups

Would let a person pick the address that passes the domain rule; needs `read:org` for everybody.

## History

- 2026-11-27: in local mode the GitHub provider uses Vaubaan's OAuth App, back on the loopback ([local-instance-carries-installed-oauth-clients](local-instance-carries-installed-oauth-clients.md)).
