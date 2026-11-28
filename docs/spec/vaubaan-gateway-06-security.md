---
title: Vaubaan Gateway spec §6 — Security
status: draft
---

# Vaubaan Gateway spec — §6 Security

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §6").

## 6. Security

- **One trust domain.** The operator has access, in running memory, to decrypted credentials during
  a call
  ([trust-model-clear-at-rest-idp-style](../decisions/trust-model-clear-at-rest-idp-style.md)).
- **Encryption at rest.** Account credentials are encrypted with a key derived from the master
  key, unique per account, the account id as authenticated data. The master key never lives in
  the store and leaves the process environment once read. Rotation reseals every stored secret, then
  the previous key is removed
  ([master-key-rotation-reseals-every-blob](../decisions/master-key-rotation-reseals-every-blob.md)).
- **Backups**
  ([scheduled-encrypted-backup-to-object-storage](../decisions/scheduled-encrypted-backup-to-object-storage.md)).
  A backup is a consistent copy of the store. A scheduled backup is encrypted under a key derived
  from the master key (the bucket holds ciphertext only), checked before it leaves (restored aside,
  integrity checked, every sealed secret opened) and uploaded only if it passes. The latest backup's
  outcome is shown to administrators and, without secrets, on the health endpoint; each backup and
  failure is in the activity. Restore accepts an encrypted backup with its checksum and opens it
  with the key versions it names. Backups beyond the configured count are deleted; nothing else in
  the bucket is touched.
- **No credential to the executor.** §2.4. No read returns a secret value under a non-secret risk:
  an answer that may carry secrets passes an allow-list of non-secret fields (others become
  `[redacted by Vaubaan]`); reading secret values is a dedicated `data: secret` risk, row 2 at least, so
  Careful asks before it.
- **Transport.** Plain HTTP on the local network, behind a TLS termination held by the company.
- **Human authentication.** Each sign-in attempt carries its own `state`, nonce and PKCE verifier
  and is bound to the sign-in provider that started it. A sign-in is admitted only on an email the
  sign-in provider verified, matching its allowed domains, the invitation list or the administrators — or, for a
  tenant sign-in provider without allowed domains, any tenant user. An unverified email never admits nor
  makes an administrator. A sign-in whose groups could not be read is refused, never read as "no
  group" (`groups-unavailable`, `groups-overage`)
  ([users-keyed-by-issuer-and-subject](../decisions/users-keyed-by-issuer-and-subject.md)).
- **Sign-in accounts**
  ([local-accounts-sign-in-provider](../decisions/local-accounts-sign-in-provider.md)): passwords
  hashed with a memory-hard function; a wrong password answered like an unknown address; the form
  rate-limited; a password of at least 12 characters; an account locked 15 minutes after 10 wrong
  passwords in 15 minutes. Creation and reset links are single-use, expire in 15 minutes and are
  stored as digests. Password hashes, second-factor secrets and recovery codes are sealed under the
  master key and never reach a log, the audit or the telemetry.
- **Second factor** before the session exists (a time-based code never accepted twice, or a recovery
  code used once), unless waived for that sign-in provider, never for an administrator. An instance
  in local mode, reached from its own computer only, asks it of the people who enrolled one and
  enrols nobody by force
  ([amendment](../decisions/local-accounts-sign-in-provider.md#amendment-2026-11-25--local-mode-enrols-no-second-factor-by-force)).
- **Recovery by the master key**: a page reachable without a session lets the key's holder do one
  thing, name one administrator or set a new password for one sign-in account (its second factor
  kept, its sessions ended); the key never leaves the browser (it proves holding it against a
  single-use challenge); the act is audited, mailed to the administrators when the instance sends
  mail, and shown on every page for thirty days.
- **Web sessions** are bound to the instance's origin and last 8 hours at most, 1 hour idle; a
  person, or an administrator for them, can end all their sessions at once. Every mutation requires
  a valid session and an origin check.
- **No self-lockout**: unmaking an administrator, deactivating a person, switching off or removing a
  sign-in provider are refused when they would leave no administrator a way in.
- **What a service says stays with the agent.** A service's error text reaches the calling agent
  only; the instance logs, stores and shows the status in its own words
  ([provider-error-text-stays-with-the-agent](../decisions/provider-error-text-stays-with-the-agent.md)).
- **Browser hardening set by the instance itself**, whatever TLS terminator is in front: a
  Content-Security-Policy admitting only the instance's own scripts and forbidding framing,
  `nosniff`, a same-origin referrer policy, a permissions policy granting no device, HSTS when the
  public URL is https.
- **Separation of the two credentials.** The mission token opens the execution surface (the MCP
  door and the git remote) only, the web session the interface only; requests are granted only in
  a web session. An executor can neither claim for itself nor approve itself.
- **An executor cannot modify its mission.** No tool edits a mission. A mission holding a Vaubaan
  account (§4.1 bis) never rotates nor revokes itself, and a mission it issues never carries a
  Vaubaan account: checked by the host at every call, whatever the stored selection says, like the
  instance's own resources ([ADR](../decisions/platform-management-is-a-plugin-on-the-execution-door.md)).
  Only the creator's own key or a machine key calls those tools. Every mission issued this way
  names, on the mission and in the audit, the mission that prepared it, and acts in the creator's
  name only.
- **Authoritative, atomic counting.** Budget decision and decrement are one operation: two
  concurrent calls on a quota's last credit give exactly one allow and one refusal
  ([atomic-budget-accounting](../decisions/atomic-budget-accounting.md)).
- **Anti-replay and anti-redirect** on service authorization flows: single-use nonce, return URL
  limited to the public URL.
- **A pasted token is checked at the service before it is stored**; a call the service refuses for a
  permission the token lacks is reported naming what it needs. The gateway narrows nothing itself:
  the mission's decision narrows a call.
- **Notifications carry no decision and no secret.** A yes is given in a web session only; a
  notification names a mission and a tool, never an argument (§4.2 bis). Device subscriptions,
  messaging addresses and the signing key pair are sealed under the master key and reach no log,
  audit or telemetry.
- **Surface rate limits** per mission on the MCP endpoint (shared by its tokens), per user on
  connect flows (ten attempts a minute), per address on the request page and every anonymous
  surface.
- **Mission tokens at rest**: only a SHA-256 digest is stored
  ([mission-token-sha256-digest](../decisions/mission-token-sha256-digest.md)).
- **No secret in logs.** Mission tokens are logged by prefix; arguments only hashed.
- **Immutable audit.** No update or delete from the application; purge by retention only (§8).
- **Leak-free telemetry.** §9.
