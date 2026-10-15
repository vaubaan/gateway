---
title: A company-directory provider can require a verified email, read from a configurable claim
status: accepted
date: 2026-10-13
extends:
  - sign-in-providers-admission-and-admin-rule
  - sign-in-hardening-host-cookies-group-overage
---

# A company-directory provider can require a verified email, read from a configurable claim

## Context

`admin.emails` makes an operator of whoever signs in with a listed address. On
an open provider (Google, GitHub, multi-tenant Microsoft) the gateway already
requires the provider to say the email is verified. A tenant-pinned issuer is a
"company directory", trusted on its word: an absent `email_verified` is
accepted.

Security review 2026-10-15 (auth M3), about an Entra ID instance: Entra ID v2
ID tokens carry no `email_verified`; the `email` claim of a member is the
directory's `mail` attribute, which User Administrators — a common role,
distinct from the one that administers the app registration — can set to any
string, including an address in `admin.emails`. For a single-tenant app,
Microsoft's removal of unverified email claims does not apply. Microsoft offers
the optional claim `xms_edov` (email domain owner verified) for relying parties
that must tell.

## Decision

1. Two per-provider options, OIDC providers of the configuration only:
   - `sign_in.<id>.claims.email_verified` (`VAUBAAN_SIGN_IN_<ID>_CLAIM_EMAIL_VERIFIED`):
     the claim that says the email is verified. Default `email_verified`; on
     Entra ID, `xms_edov`. `mapClaims` reads it for both the floor (an explicit
     `false` is refused) and the signal (`emailVerified: true`).
   - `sign_in.<id>.require_verified_email` (`…_REQUIRE_VERIFIED_EMAIL`):
     when true, `admit()` applies the open-provider rule to this directory —
     no sign-in without the verified signal.
     Both default to the behaviour before this change. A GitHub provider refuses
     `require_verified_email` (it only ever gives the primary verified address).
2. The deploy guidance is explicit: on Entra ID the admin rule is a **group by
   object id** (`VAUBAAN_ADMIN_GROUP=<provider>:<object id>`), with
   `admin.emails` empty or a break-glass list; an email rule that must stay is
   paired with `xms_edov` and `require_verified_email: true` (handbook
   authentication, "Entra ID: make the admin rule a group, by object id").
3. Default unchanged. The threat model re-evaluated A22/A29: the risk is real
   only for an email rule on a directory whose email attribute is editable by
   non-owners; the fix is configuration that the operator chooses, and turning
   `require_verified_email` on by default would refuse every Keycloak or Okta
   sign-in that never sends the claim.

## Consequences

- An Entra instance that follows the guidance no longer makes an operator of a
  tenant user whose `mail` was set to an administrator's address.
- `xms_edov` is true only for an address in a domain the tenant verified: a
  guest or an address at a domain the tenant does not own is refused when the
  option is on.
- Providers saved from Settings → Sign-in do not have the options (the form is
  unchanged); they are for providers of the configuration, where an operator
  decides the instance's security posture.

## Rejected alternatives

- **Require `email_verified` for every directory.** Most directories (Keycloak
  by default, Okta, Entra) never send it: every sign-in would be refused.
- **Special-case Entra by issuer** (`login.microsoftonline.com/<tenant>`).
  Implicit, and wrong for tenants that did not add the optional claim; an
  explicit option documents itself.
- **Drop `admin.emails` for directories.** It is the simplest rule where the
  directory owns the address, and a useful break-glass list.
