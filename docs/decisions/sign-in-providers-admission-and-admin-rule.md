---
title: Several sign-in providers per instance — admission by domains, invitations and admin emails; the admin rule names its provider
status: accepted
date: 2026-10-13
extends:
  - oidc-relying-party-and-web-session
  - users-keyed-by-issuer-and-subject
  - operator-deactivates-a-user
---

# Several sign-in providers per instance — admission by domains, invitations and admin emails; the admin rule names its provider

> The owner, 2026-10-14: an instance must work for a company on Entra ID (or
> Google Workspace, Okta, Keycloak) **and** for private persons signing in
> with their own accounts (personal Google, personal Microsoft, GitHub),
> several providers at once. First real use: the dogfooding instance on
> Railway, signing in with GitHub. Handbook:
> [authentication](../handbook/authentication.md).

## Context

An instance had one OpenID Connect provider (`idp.*`, or the same settings
saved from Settings → Sign-in), whose callback is `<public_url>/auth/callback`.
Admission was "every email the provider vouches for, optionally filtered by
domain". That is right for a company directory, which only holds the company's
people. It is wrong for a provider where anyone in the world holds an account:
pointed at `accounts.google.com` or at GitHub, an empty domain list admitted
the internet, and the admin rule's `admin.emails` would make an administrator
of whoever registered that address there.

With several providers three more questions appear: which provider a sign-in
belongs to (a response of one must not complete an attempt of another), what
an IdP group means when two providers can claim the same name, and what
happens to the people of a provider that is removed.

## Decision

1. **A list of providers.** Configuration: the `idp.*` keys stay, as the
   provider with the id `idp`; any number of `sign_in.<id>.*` providers
   (`VAUBAAN_SIGN_IN_<ID>_<FIELD>`) come beside it, each with an id, a name, a
   kind (`oidc` | `github`), its issuer, client id, client secret (by
   reference), claim mapping (OIDC), allowed email domains and "invitation
   only". Settings → Sign-in adds, edits, tests and removes providers stored in
   `instance_config` (`sign_in.<id>` as JSON, the secret sealed under
   `sign_in.<id>.client_secret`; the provider `idp` keeps the single-provider
   keys), audited as `config-changed` on `instance-config` / `sign-in:<id>`
   without the secret. A provider of the file is read-only there and wins over
   a stored one of the same id. Two providers may not share an issuer.
2. **One attempt, one provider.** `GET /auth/login/<id>` starts a sign-in; the
   pending sign-in records the provider; `GET /auth/callback/<id>` finishes it,
   and a callback of another provider is refused (`state-mismatch`). The
   provider `idp` keeps `/auth/callback`, already registered at the companies'
   providers; `/auth/login` without an id goes straight to the one provider, or
   to the sign-in page to choose when there are several. An ID token whose
   `iss` is not the provider's issuer is refused.
3. **Identities never merge by email.** A user stays (issuer, subject). The
   same person through Google and through GitHub is two users; nothing links
   them. The People page says so.
4. **Admission.** A sign-in is admitted on an email the provider verified
   (an explicit "unverified" is always refused; an **open** provider must say
   "verified" outright) when the email is in the provider's allowed domains,
   on the instance-wide **invitation list**, or in `admin.emails` — or, for a
   company directory with no domain and not "invitation only", for everyone the
   directory authenticates. A provider has one of three rules: everyone of the
   directory, domains (plus invitations), or invitations only; "invitation
   only" with domains is refused. An **open** provider — GitHub (and a GitHub
   Enterprise Server, whose sign-up policy the instance cannot know), Google
   accounts (`https://accounts.google.com`), Microsoft personal accounts and
   the multi-tenant endpoints — is refused at load and in Settings without
   domains or "invitation only", with a message that says why. A refused
   sign-in writes nothing.
5. **Invitations.** A table `invitations` (migration 0014): lower-cased
   addresses, who invited, when. Administrators invite and remove on Settings →
   People, audited (`invitation-added`, `invitation-removed`). An invitation is
   read at each sign-in; removing it stops the next sign-ins, not an open
   session (deactivation stops a person at once).
6. **The admin rule across providers.** `admin.emails` matches the email of a
   user of any provider (every stored email passed admission). `admin.group`
   names its provider: `<provider>:<group>`. A bare name is accepted while one
   provider is configured (the earlier form keeps working) and is refused once
   there are several — at load, and when a provider added in Settings would
   make it ambiguous or change what it names. A `<provider>:` prefix that names
   no configured provider matches nobody, so a rule written for a removed
   provider never falls to another one (except for the one provider `idp`, whose
   group names may contain a colon).
7. **Groups belong to their provider.** `groups.provider` (migration 0014)
   records the provider that claimed an IdP group; every existing IdP group is
   the provider `idp`'s. A name claimed by a user of another provider is
   skipped and logged, exactly as a name held by a local group is. The admin
   rule counts a membership only when the group's provider is the rule's.
8. **Removing a provider.** Its users cannot start a sign-in (`provider-unknown`);
   removing it in Settings ends their sessions at once
   (`users.sessions_ended_at`, the deactivation's mechanism, without the
   status). Their missions, keys and connected apps follow the rules of a
   deactivation: they run until an administrator deactivates the person — the
   removal dialog and its notice say how many people it concerns.

## Consequences

- An instance can sign in its company and outside people at once; the Railway
  dogfooding instance runs on GitHub alone, invitation only, its administrators
  named by `admin.emails` (admitted although nobody invited them) or by a
  `github:org/team` rule.
- A configuration that pointed `idp.issuer` at an open issuer with no domains
  no longer loads; it says what to set (`idp.allowed_email_domains` or
  `idp.invitation_only`). This is the one deliberate refusal of an existing
  configuration: it admitted anyone.
- An administrator email outside the allowed domains is now admitted (it was
  refused): the configuration names that person.
- Accepted risks A28 (removing a provider does not deactivate its people) and
  A29 (`admin.emails` through any provider) in the
  [threat model](../handbook/threat-model.md).
- `bindUnboundTo` (migration 0011) runs only for a sign-in of the provider
  `idp`: accounts from before 0011 belong to it.

## Rejected alternatives

- **Linking identities by verified email.** It would let the weakest provider
  open the strongest one's account (a self-managed directory, an address
  re-registered elsewhere). An explicit, administrator-made link may come later;
  not built.
- **A per-provider invitation list.** Invitations name people, not providers;
  one list is what an administrator understands. Domains are per provider
  because they describe a directory.
- **Treating every unknown issuer as open.** It would refuse every Keycloak or
  Okta without domains, a working configuration today. The open list names the
  public services; an operator who runs a public-sign-up directory sets
  "invitation only" themselves.
- **Ending missions when a provider is removed.** A provider is removed for
  reasons that are not about its people (a migration to another directory);
  deactivation stays the one act that stops a person, with its own dialog.
- **Prefixing every group name with its provider in `groups.name`.** It would
  orphan every group-owned connection of an existing instance (`eng` becoming
  `idp:eng`); a provider column keeps the names.
- **A separate table for sign-in providers.** `instance_config` already holds
  sealed settings per key with an atomic multi-key write; providers are few.
