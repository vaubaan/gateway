---
title: Local accounts — a sign-in provider that lives in the instance, with a second factor and links sent by the instance's own mail
status: accepted
date: 2026-10-19
extends:
  - sign-in-providers-admission-and-admin-rule
  - oidc-relying-party-and-web-session
  - users-keyed-by-issuer-and-subject
  - sign-in-rate-limits-and-bootstrap-lockout
---

# Local accounts — a sign-in provider that lives in the instance, with a second factor and links sent by the instance's own mail

> Decided by the owner on 2026-10-19. Applied in spec
> [vaubaan-gateway](../spec/vaubaan-gateway.md) §0 "Local account", §1.1,
> §4.2, §4.3, §6, §7.1, §10, §11.1; handbook
> [authentication](../handbook/authentication.md), "Local accounts".

## Context

Since v5 the gateway delegates every human sign-in to a provider the company
already has: its directory through OpenID Connect, or GitHub. A team without
a directory — a small company, a freelancer, a lab, a company whose Google
Workspace or Entra tenant the operator may not touch — had no way in but a
public provider with an invitation list, which ties the gateway to that
service's account policy and its availability. The gateway holds the
company's provider credentials, and the first thing an operator asks after
installing it is how colleagues sign in; "register an OAuth app at a third
party first" is a wall for exactly the teams a self-hosted instance is for.

Everything but the account itself already exists: short web sessions, an
admin rule, an invitation list, a setup page with a bootstrap token, a
sealed store, rate limits on the sign-in endpoints.

## Decision

1. **A sign-in provider of kind `local`.** One more `sign_in.<id>` beside
   `oidc` and `github` (default id `local`, at most one per instance). Its
   issuer is `urn:vaubaan:local:<id>`, so a person is (issuer, subject) as
   everyone else, the subject being the account's id: identities never
   merge by email, an account removed and created again is somebody else.
   It is set from the configuration (`sign_in.<id>.kind: local`, a name,
   nothing else) or from Settings → Sign-in in one click.
2. **An account is an e-mail and a password, under the invitation rule.**
   The provider is always "invited only": an account exists only for an
   address an administrator invited or that the admin rule names, and is
   created by the person through a single-use link (D5) or by the setup
   (D7). The password is hashed with **argon2id** (libsodium's
   `crypto_pwhash_str`, interactive limits), at least 12 characters and at
   most 256 bytes, no composition rule, never shown or logged. Admission is
   the one of every provider (`admit()`): the address must still be invited
   or named by the admin rule at every sign-in, and a deactivated user is
   refused as through any provider.
3. **A rate limit and a lockout.** The password form takes the sign-in
   windows of ADR sign-in-rate-limits-and-bootstrap-lockout (per address,
   per instance) and, per account, **10 wrong passwords in 15 minutes lock
   the account for 15 minutes**, counted in the store so that a restart
   does not reset it. The refusal is one sentence for every cause (unknown
   address, wrong password, locked account): no enumeration.
4. **A second factor, TOTP (RFC 6238), required for administrators.** An
   account enrols a TOTP secret from a QR code (`otpauth://`, SHA-1, 6
   digits, 30 s, one step of drift, a code never accepted twice) and
   confirms it with one code; eight **recovery codes** are shown once and
   kept hashed. A sign-in with a second factor is two steps (password, then
   code or recovery code), bound by a pending-login cookie as an OpenID
   Connect attempt is. A person the admin rule makes an **operator** cannot
   finish a sign-in without a second factor: the enrolment is the next
   step of their sign-in. Other users enrol from Settings. An administrator
   can reset another person's second factor (audited); a lone
   administrator who loses password, authenticator and recovery codes is
   locked out, and the setup says so: the instance cannot open an account
   for anyone.
5. **Invitations and resets are single-use links, 15 minutes, sent by the
   instance.** Inviting an address when a local provider exists also
   creates an account-creation link; "Forgot your password" creates a
   reset link for an existing account and answers the same sentence for an
   unknown address. A link's token is random (32 bytes); the store keeps
   its SHA-256 only, with its expiry and its use. The account is created or
   changed on the link's use alone. An administrator can send a link again,
   and, without mail delivery, copy it from People to hand it over
   themselves.
6. **Mail delivery is a section of the instance configuration**
   (`mail.*`: SMTP host, port, user, password, sender, TLS), used by this
   provider and available to the rest of the gateway. Without it the
   provider works: links are shown to the administrator to copy, and the
   reset form says to ask an administrator. A failed send is logged
   without the recipient's address or the link.
7. **The setup creates the first administrator.** While the bootstrap
   token is active and a local provider exists, the setup checklist asks
   the operator to create the account of an address of `admin.emails`:
   password, second factor, recovery codes, in that order; the account
   signs in through the provider, and that sign-in revokes the bootstrap
   token as any operator's does. An admin rule made of a group alone cannot
   name a local account: the page says so.
8. **Sealed like the rest.** Password hashes, TOTP secrets and
   recovery-code hashes are sealed blobs of the store (associated data: the
   account id), resealed with every other blob at a key rotation; the links'
   token hashes are digests of random values and are stored as such, as a
   mission token's is. Nothing of it reaches the logs, the audit (`after`
   carries the address and the event, never a secret) or the telemetry,
   which counts the provider's kind only.

## Consequences

- A self-hoster without a directory installs the image, creates their
  administrator account at the setup, invites colleagues by mail: no
  third-party registration. The OpenID Connect and GitHub providers stay
  for a company with a directory, and the three kinds coexist.
- The gateway now keeps a secret per person (a password hash) and a shared
  secret per enrolled account (the TOTP seed): one more reason the store is
  sealed and the master key is the operator's to keep. A backup restored
  elsewhere brings the accounts with it; a restore under another key opens
  none of them.
- One outward dependency for invitations and resets: a mail relay, a
  standard one. Sign-in itself needs none.
- Three dependencies: `libsodium-wrappers-sumo` replaces
  `libsodium-wrappers` (same vendor and version; the standard build ships no
  `crypto_pwhash`), `nodemailer` for SMTP, `uqr` for the QR code (no
  dependency of its own). The TOTP is forty lines over `node:crypto`.
- Accepted risks, in the [threat model](../handbook/threat-model.md): a
  password is a credential the person chooses; a TOTP seed is a shared
  secret; a link's 15 minutes are a window during which a mailbox grants an
  account.

## Rejected alternatives

- **A magic-link sign-in (no password).** It makes the mailbox the whole
  credential, and mail delivery a dependency of every sign-in rather than of
  invitations and resets. A password plus a second factor keeps the
  mailbox to the enrolment.
- **Passkeys (WebAuthn) instead of TOTP.** Stronger and phishing-resistant,
  but a self-hoster's instance is reached from several browsers and
  machines, and the recovery story needs the same codes anyway. Can be
  added as a second kind of factor later; the account model does not
  prevent it.
- **Native argon2 (`argon2`, `@node-rs/argon2`).** A native addon to build
  or trace in the standalone image, where the WebAssembly libsodium already
  used for sealing offers argon2id in its "sumo" build.
- **`scrypt` from `node:crypto`.** No dependency at all, but the spec of
  the store already names argon2id for the one hash the gateway kept
  before (ADR api-key-format-vbn-live-argon2id) and libsodium is there.
- **A second factor optional for everyone.** An administrator's session
  reaches every connection's credentials through the pages and the setup
  kit; a password alone is below the bar for that session.
- **Links without expiry.** Unused invitation links in old mailboxes are
  accounts waiting for whoever reads the mailbox; 15 minutes and "send
  again" keep the window short.
- **Sending mail through a provider plugin (Resend) rather than SMTP.** The
  gateway's own mail must not depend on a connection somebody may revoke,
  and SMTP is what every relay speaks.
