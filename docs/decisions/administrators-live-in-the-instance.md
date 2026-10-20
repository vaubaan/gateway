---
title: The administrators live in the instance — named from inside, tested beside the session, recovered by the master key, loudly
status: accepted
date: 2026-10-20
extends:
  - sign-in-providers-admission-and-admin-rule
  - oidc-relying-party-and-web-session
  - local-accounts-sign-in-provider
  - sign-in-rate-limits-and-bootstrap-lockout
  - master-key-generated-and-handed-over-by-the-instance
  - restore-verifies-before-it-replaces-and-runs-at-first-boot
  - operator-deactivates-a-user
  - backup-carries-the-sign-in-configuration
---

# The administrators live in the instance — named from inside, tested beside the session, recovered by the master key, loudly

> Requested on 2026-10-20 by the managed offer (`vaubaan-cloud`, spec
> `managed-instances` §10.2 item 20, folding items 13 and 18 in), after two
> incidents of the same day; accepted by the owner the same day, who asked
> for the open questions to be settled in this record rather than put to
> him (§"Questions settled here"). Every part is a feature a self-hoster
> needs as much as the managed offer. Delivered in five slices (§"Delivery").

## Context

Until now the administrators of an instance were whoever matched the
**admin rule** of the configuration (`admin.emails`, `admin.group`),
required at boot and recomputed on every request. Four consequences, each
seen live:

1. **Power from outside.** Whoever writes the instance's environment names
   its administrators, without the instance or its administrators seeing it.
   In the managed offer that is the control plane; for a self-hoster it is a
   file set once and forgotten. On 2026-10-20 the Fiabilis administrator was
   locked out of their own instance because the rule named their personal
   address while they sign in through Entra ID with their company one — two
   users for the gateway — and the only way out was the same lever (the
   environment changed by hand).
2. **A restore locks out.** The store carries `bootstrap.revoked_at` from
   its first host; restored elsewhere, the new setup link is refused while
   the providers the old host set by environment are gone (the dogfood, the
   same day). The documented way out was a shell in the container.
3. **Testing a provider replaces the tester's session.** "Test" ran the real
   sign-in: a misconfigured provider signs the administrator out; removing a
   provider ends every session of its users, the remover's included.
4. **The bootstrap token ends by a side effect** (the first sign-in of a
   person the rule names), and nothing prevents the last administrator from
   removing their only way in. The only recovery after a lockout is a shell.

The local accounts (ADR local-accounts-sign-in-provider) also made a second
factor available, but only for local accounts and only required of the
people `admin.emails` names: an administrator signing in through a directory
had none the instance could see.

Facts that shape the choices below:

- The master key is **32 random bytes, symmetric** (`crypto/master-key-file.ts`;
  sealing derives a per-connection key with keyed BLAKE2b, `crypto/aead.ts`).
  There is no key pair, so "a signature of a server challenge" can only be a
  **MAC**: proof of possession of a secret both sides hold. The instance
  holds the key in memory, so it can check such a proof.
- Web Crypto (`crypto.subtle`) offers HKDF and HMAC-SHA-256 in every browser,
  in a secure context; the instance's sessions already require https
  (`Secure` cookies), so the recovery page always runs in one. It offers no
  BLAKE2b.
- An ID token may carry `amr` (RFC 8176): Entra ID and Okta put `mfa` in it
  when the person passed a second factor; Google does not reliably; GitHub's
  OAuth sign-in has no ID token at all.
- `instance_config` holds small sealed or plain settings with an atomic
  multi-key write; the users table is keyed by (issuer, subject); the session
  store already has record kinds (session, pending login, local step).

## Decision

### 1. Administrators are rows of the store

A new table `administrators` (migration `0020`) holds **designations**, one
row each:

| kind    | names                                                     | lifetime                                                                                    |
| ------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `user`  | one user (`user_id`)                                      | until unmade                                                                                |
| `email` | an address, for one provider (`provider`) or any (`NULL`) | **pending**: at the first sign-in it admits, it becomes a `user` row and is removed         |
| `group` | a group of one provider (`provider`, `group_name`)        | live: every member that provider claims, recomputed on each request as the rule's group was |

Each row records who made it (`granted_by`: a user id, `bootstrap`,
`configuration`, `recovery`) and why (`origin`: `setup`, `granted`,
`configuration`, `recovered`). **A person administers the instance** when
they are an active user with a `user` row, or a member — as its own
provider claims — of a `group` row's group. Nothing else makes an
administrator: not the configuration after the first boot (§2), not a local
group.

Administration → Users shows an **Administrators** section: every
designation, with "Make administrator" on a user and "No longer
administrator" / "Remove" on a designation, both audited
(`administrator-granted`, `administrator-revoked`) and both under the
no-lockout rule (§6). An administrator can also add a group designation
(a provider and a group name).

### 2. The configuration's rule is a seed, read while the store names nobody

`admin.emails` and `admin.group` become **optional**. When the store holds
no designation at all and the configuration has a rule, the boot **applies
it once**: each address becomes an `email` designation for any provider
(the semantic of `admin.emails` until now), and every existing active user
with that address becomes a `user` row at once; the group becomes a `group`
designation of the provider it resolves to now (`resolveAdminGroup`). The
rule applied is recorded in `instance_config` (`administrators.seeded_rule`,
canonical JSON) with one `administrators-seeded` audit entry (actor
`configuration`).

After that, **the configuration grants nothing silently.** At each boot, a
rule that differs from the one applied is logged at `warn` and shown on
Administration (setup page and Users) with what it would add; an
administrator may apply it with one click ("Apply the configuration's
rule"), which writes ordinary `administrator-granted` entries in their name.
A rule removed from the configuration removes nobody.

**Upgrade of an existing instance (dogfood, Dalae, Fiabilis).** Their store
holds no designation and their configuration has a rule: the first boot of
this version seeds it. Every person the rule made an administrator before
the upgrade is one after it — by `user` row when they had signed in, by the
pending `email` row or the live `group` row otherwise — so nobody is locked
out; the integration test "an upgraded instance keeps its administrators"
checks it for an email rule and for a group rule (the Fiabilis shape:
`<provider>:<group object id>`, admitted on the group alone).

**Boot refusal.** A configuration with no rule and no bootstrap token, on a
store that names nobody, has no way to get a first administrator: the boot
stops (exit 78) and says to set `bootstrap_token` (or an admin rule). The
loader alone cannot see the store, so the check is the composition root's.

### 3. Admission follows the designations

`admit()` replaces its reasons `admin-email` and `admin-group` by one,
`administrator`: a sign-in is admitted when the identity is a `user`
designation (issuer, subject), matches a pending `email` designation of its
provider or of any provider, or is claimed a member of a `group`
designation's group by that group's provider. Every rule of admission still
holds before it (an open provider must say the email is verified; nothing is
written on a refusal). A GitHub provider reads the teams of every `group`
designation that names it, as it read the rule's team.

The pending `email` row is consumed by the sign-in that matches it, in the
same transaction as the user's row: the address becomes that one person, and
another provider's account with the same address is no administrator (the
weakness accepted as A29 shrinks to the first sign-in of a pending address).

### 4. The holder of the setup link names the first administrator

While the bootstrap token is active, the setup (bootstrap principal, or an
administrator) names the first administrator, either:

- **with local accounts**: the account of **any address typed** (no longer
  only an address of `admin.emails`) — password now, second factor and
  recovery codes at its first sign-in; the setup writes the account, its
  `users` row and a `user` designation (`origin: setup`) together; or
- **through a provider**: after a passed test of the provider (§5), the
  test's result page offers "Make <address> an administrator", which writes
  the tested identity's `users` row and a `user` designation. The test
  result it reads is the one the instance stored for this session, never a
  form field.

### 5. A provider is tested beside the session, and enabled after a passed test

- **Test route.** `GET /auth/test/<id>` (an administrator or the bootstrap
  principal) starts the provider's flow in a **new window** with a pending
  record of its own kind (`test`, cookie `vbn_test`, ten minutes, single
  use, `state`/nonce/PKCE as a sign-in). The provider redirects to the same
  registered callback (`/auth/callback/<id>`); a callback whose `vbn_test`
  record matches the `state` is a test. The flow goes to the end at the
  provider; the instance then **creates no user, no session, syncs no group,
  consumes no designation and revokes nothing**, and shows on
  `/admin/identity-provider/<id>/test`: the provider, the subject, the email
  and whether it is verified, the groups (and teams), the `amr` when there is
  one, and **the verdict it would give** — admitted as administrator,
  admitted as user (and by which rule), or refused (and why). The tester's
  session is untouched.
- **Stored result.** `sign_in.<id>.test` in `instance_config`: when, by
  whom, the outcome (`passed` = the provider returned an identity the
  instance accepts as one; or the closed error code), the identity seen and
  the verdict; audited as `sign-in-provider-tested`.
- **Enabled.** A provider saved from Settings carries `enabled`. An OpenID
  Connect or GitHub provider is **saved disabled**; an administrator enables
  it once a test passed after its last save (`sign-in-provider-enabled`).
  Local accounts are enabled when added (nothing to test). A provider of the
  configuration file is always enabled. Providers saved before this version
  read as enabled (they were in use). A disabled provider is not on the
  sign-in page and `/auth/login/<id>` refuses it (`provider-disabled`);
  disabling it ends its users' sessions like a removal
  (`sign-in-provider-disabled`). **Editing** an enabled provider keeps it
  enabled and marks its test stale ("changed since the last test", with the
  Test button): an expiring client secret must be replaceable without
  passing through "disabled".

### 6. No self-lockout

**A way in** for an administrator is: an active user, administrator by a
`user` row or a group membership, whose provider (found by the user's
issuer) is configured and enabled — for local accounts, whose account
exists. An act is **refused** when the instance has at least one
administrator with a way in before it and would have none after it:
unmaking or removing a designation, deactivating a user, disabling or
removing a provider. Resetting another administrator's second factor is not
a lockout (the person enrols a new one at their next sign-in, §7), and an
administrator still cannot remove their own. Removing or disabling a
provider ends the other users' sessions, **never the remover's own**.

### 7. A second factor in the instance, by default, for everyone

- **Per user, not per local account.** The TOTP of local accounts moves to
  the user: tables `user_second_factors` (confirmed when, last accepted time
  step) and `user_second_factor_secrets` (sealed `totp` and `recovery`
  blobs, associated data `user_second_factor:<user id>:<kind>`, in
  `SEALED_COLUMNS`). A boot step moves each local account's factor to its
  user once (opened with its old associated data, sealed with the new one,
  then deleted from `local_secrets`), idempotent; an account with a factor
  and no user yet gets its `users` row first.
- **Every sign-in, every provider**, ends with the factor step before the
  session: the code (or a recovery code) when the user has a factor, the
  enrolment (QR code, first code, recovery codes shown once) when they have
  none. The step is a pending record bound to the user and the provider,
  ten minutes, as the local step was. Users who already signed in enrol at
  their next sign-in; open sessions are not ended.
- **Waiver per provider**, from Settings → Sign-in only (never from the
  configuration: it lowers what the instance checks), stored as
  `sign_in_waiver.<id>`: `always` ("this directory enforces its own second
  factor": the administrator's word) or `amr` (only for a sign-in whose ID
  token's `amr` contains `mfa`; otherwise the factor is asked). An OpenID
  Connect provider takes either, GitHub `always` only, local accounts
  neither. Explicit confirmation, `second-factor-waiver-changed` entry, and
  a standing notice on the provider and on Sign-in while waived. **Never for
  an administrator**: the factor is tied to the administrator status, not to
  `admin.emails`.
- An administrator resets another person's factor from People
  (`second-factor-changed`, `by` = the actor); a person replaces theirs
  from Settings → Security after a fresh sign-in; an administrator cannot
  remove their own.

### 8. The setup ends by an explicit step

"Finish setup" (`POST /api/admin/setup/finish`, administrator or bootstrap
principal, origin-checked) revokes the bootstrap token and writes
`setup-finished`. It is allowed only when the master key was handed over
(when the instance generated it) and at least one administrator has a way
in (§6) — a local account named by the setup, or an identity made
administrator from a passed test. **No sign-in revokes the token any
more.** The 50-wrong-tokens revocation stays. An upgraded instance whose
token was still active keeps its setup open until an administrator finishes
it; the checklist says so.

### 9. Recovery by the master key, loudly

- **Page.** `/admin/recover`, reachable without a session. The person
  chooses the key file; **the key never leaves the browser.** The page
  derives `K = HKDF-SHA-256(master key, salt = "", info =
"vaubaan/recovery-proof/v1")` and sends
  `HMAC-SHA-256(K, "vaubaan-recovery-v1\n" + public origin + "\n" +
challenge)`, base64url. The instance computes the same with its **current**
  key (not a previous one: a rotated-out key has stopped opening the store)
  and compares in constant time.
- **Challenge.** 32 random bytes from `POST /api/recover/challenge`, kept as
  a pending record (`recovery-challenge`, cookie `vbn_recover`, five
  minutes, single use). The two endpoints are origin-checked and share an
  instance-wide window of 10 attempts per 10 minutes; every refused proof is
  logged at `error`.
- **What it opens.** A recovery session (`recovery`, fifteen minutes, its
  own cookie) that can do **one thing**: name an administrator — an
  existing user (by provider and address), an address for one provider
  (pending `email` designation; for local accounts the page also shows the
  account-creation link once, as no mail may be set), or a group of a
  provider. The naming ends the recovery session.
- **Loud.** One `administrator-recovered` entry (actor `recovery`, what was
  named); a mail to every active administrator with an address when mail
  delivery is set; and a **banner on every page of the interface, for every
  signed-in person, for thirty days** (`recovery.last` in
  `instance_config`), naming the date and what was named. Holding the key
  already opens every secret of the instance: this grants no new power, and
  makes its one use visible.

### 10. Restore keeps the administrators

A restored store carries its designations (and, with the backup of the
sign-in configuration, their providers): the setup does not reopen, the
configuration's rule of the new host applies only if the store names nobody
(§2), and the new host's bootstrap token stays refused when the copy's was
revoked. A restored instance that nobody can enter is the case of §9.
`bootstrap.revoked_at` is never cleared by a restore (the request of
2026-10-20 to clear it is withdrawn: it would let the new host name an
administrator after every restore).

**`restored.admin_rule` (ADR backup-carries-the-sign-in-configuration, D4) is
superseded.** That ADR, merged the same day, carried the source's admin rule
in a copy as the key `restored.admin_rule` and merged it with the configured
rule at every boot. From this version the `backup` command writes no such key
(the administrators are rows of the copy) and the boot merges nothing into the
configuration. A copy that carries the key (made by a build between the two)
is read once by the seed of §2: while the restored store names no
administrator, the carried emails and group become designations with the
configuration's — both groups kept, since the store holds several — and the
key is deleted; a store that already names administrators drops the key
unread. The configuration's own rule is what is recorded as applied, so the
carried one causes no drift notice afterwards.

### 11. Audit

New administrative acts (`packages/gateway-core` `AdminAct`):
`administrator-granted`, `administrator-revoked`, `administrators-seeded`,
`setup-finished`, `sign-in-provider-tested`, `sign-in-provider-enabled`,
`sign-in-provider-disabled`, `second-factor-waiver-changed`,
`second-factor-changed` (the per-user successor of
`local-second-factor-changed`, kept for past entries) and
`administrator-recovered`. Object `instance-config` / `administrators` for
designations, `sign-in:<id>` for providers, `user` for a factor. The actor
ids `configuration` and `recovery` join `bootstrap` as non-user actors.
Nothing secret in any of them: never a key, a code, a proof or a link.

## Questions settled here

The owner asked on 2026-10-20 that these be decided in this record.

1. **Recovery: key upload or proof in the browser?** Proof in the browser
   (HMAC over HKDF, §9). An upload sends the key through the TLS terminator
   — a managed host's edge — and into request memory; the proof is useless
   once used. No upload fallback: Web Crypto is present wherever the
   instance's cookies work.
2. **Does the configuration's rule stay live beside the store?** No: it is a
   seed read while the store names nobody, then shown, never applied
   silently (§2). Live, it would keep the lever of the incident.
3. **Migrated `admin.emails`: bound to a provider?** No — any provider, as
   before, until the first sign-in consumes it (§3). Binding at upgrade would
   have to guess the provider and could lock out exactly the Fiabilis case.
4. **Waiver claim.** `amr` containing `mfa` (RFC 8176), or the
   administrator's word (`always`); no per-provider list of claim values.
5. **Editing an enabled provider disables it?** No: kept enabled, test marked
   stale (§5).
6. **What may recovery name?** An existing user, an address for a provider,
   or a provider's group; one naming per recovery (§9). It does not reset a
   factor: the named administrator does that from People.
7. **Banner to whom?** Every signed-in person, thirty days: the people of the
   instance are who the trace is for.
8. **A shell command for recovery?** Not built: a shell already reaches the
   store and the key (A1); the page is the path the trace covers.

## Consequences

- Nobody outside the instance names an administrator after its first boot:
  the managed offer passes no rule, and its `inv:no-power-from-outside`
  holds once this is delivered. A self-hoster keeps a rule in a file as the
  seed of a new instance.
- Every user signs in with a second factor of the instance unless an
  administrator waives it for their provider. After the upgrade, the people
  of an instance on a directory (Fiabilis on Entra ID, the dogfood on
  GitHub) are asked to enrol one at their next sign-in; an administrator of
  an Entra provider will usually set the waiver `amr`. Said in the release
  notes.
- A new provider needs a passed test before anyone can use it; the sign-in
  page never shows a button that does not work.
- The setup has one more explicit step; a self-hoster who never clicks it
  keeps an active token, which the checklist keeps showing.
- New tables: `administrators`, `user_second_factors`,
  `user_second_factor_secrets`; new settings in `instance_config`. The local
  tables keep their accounts and links; their `totp` and `recovery` secrets
  move.
- Threat model: A29 (`admin.emails` through any provider) shrinks to a
  pending address's first sign-in; a new entry for the recovery page (a
  holder of the key can name an administrator — loudly; the page's script is
  the instance's own, so a compromised instance could read the key it already
  holds); A28 unchanged.

## Rejected alternatives

- **Keep the configuration's rule live, beside the store.** It keeps the
  outside lever the incident was about; the union of both makes "who
  administers" unanswerable from inside.
- **Clear `bootstrap.revoked_at` on restore** (the first form of the
  request). Hands the new host the power to name an administrator after
  every restore.
- **Upload the key file to recover.** The key crosses the edge and the
  request path; see question 1.
- **An Ed25519 key pair derived from the master key, signed in the browser.**
  Possible (a seed derived from the key), but the instance holds the key
  anyway, so a signature proves nothing a MAC does not, and Ed25519 in Web
  Crypto is recent in some browsers.
- **Disable a provider on every edit.** Locks out on a secret rotation of the
  only provider.
- **A second factor for administrators only** (the local accounts' rule).
  The instance could not tell a directory's account without a factor from
  one with; the waiver makes the trust in a directory explicit instead.
- **Designations by email only** (no `user` kind). An address is a claim;
  after the first sign-in the administrator is a person (issuer, subject).
- **A separate table for test results or waivers.** `instance_config`
  already keeps per-provider settings with atomic writes.

## Delivery

Five slices, each a pull request to `main` with its tests, spec and handbook:

1. **Administrators in the store** — §1, §2, §3, §4 (local), §6 (designations,
   deactivation), §10, the boot refusal, the audit acts of §11 they use.
2. **Test beside the session and enabled providers** — §5, §4 (through a
   provider), §6 (providers, the remover's session).
3. **Finish setup** — §8.
4. **Second factor for everyone** — §7.
5. **Recovery by the master key** — §9.
