---
title: Vaubaan Gateway spec §10 — Tests
status: draft
---

# Vaubaan Gateway spec — §10 Tests

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §10").

## 10. Tests

- **Unit, mandatory**, on:
  - each plugin's classifier, against recorded or doc-built service responses (a classification
    error is a security hole);
  - authority composition (§3.1): monotonicity, union of shares, partition per account, resource
    selection and `resource-not-in-mission`, environment resolution against labels;
  - the budget (§3.2, §3.3): multi-risk decrement, rollover on read, atomicity on the last credit,
    concurrent agents on one token;
  - the approval (§3.5): binding to the exact argument fingerprint, single use, expiry, whole
    refusal of a multi-risk call, gate opening bounded to the period, erasure of arguments after
    decision;
  - structured refusals: every code, field and `hint`;
  - credential separation (§6): a web session at the execution surface, a mission token on a request,
    refused unambiguously; the self rule of a mission holding a Vaubaan account;
  - sign-in accounts (§6): the memory-hard hash verifies the password only; lockout counts wrong
    passwords per account across restarts; a one-time code accepted once within one step of drift, a
    recovery code once, a link once and before expiry; unknown address and wrong password answered
    alike; no secret in a log, audit entry or report;
  - the administrators (§0, §6): the rule applied once while the store names nobody (an upgraded
    instance keeps every administrator of its rule), a changed rule naming nobody by itself, a
    pending address consumed by the first sign-in of its sign-in provider, every act leaving no
    administrator a way in refused;
  - the second factor (§6): enrolled at the first sign-in through any sign-in provider and asked at
    every one after, before the session; waived for a sign-in provider outright or on its token's `mfa`, never for
    an administrator; an earlier sign-in account's factor moved to its person;
  - recovery by the master key (§6): the browser's proof equal to the instance's, a wrong key and a
    replayed challenge refused, the recovery session naming one administrator or setting one password only, the entry, the
    mail and the thirty-day banner;
  - the sign-in provider test (§4.2): no user, session or group written, the tester's session kept,
    another session's callback refused, the verdict computed as a sign-in would, the result usable
    by the tester's session only; a sign-in provider saved off and switched on only after a test passed
    since its last save, refused at sign-in while off;
  - a service's OAuth client (§4.3, §7.2): registered by the instance, secret sealed and never
    echoed; an `oauth2` plugin declaring no registration refused at startup;
  - the mailbox over IMAP (§5): the app password checked by an IMAP sign-in before storage, folders
    found by special use, ids and labels from the classifier's grammar, a draft appended and never
    sent.
- **Integration**, on an ephemeral instance with embedded store and simulated IdP: account,
  share, issuance, claim, approval and replay, revocation, the git remote with the real `git` client
  against a local git server standing in for the service (multi-ref pushes, claimed ref values,
  malformed requests), `orphaned` states, issuance by an MCP client holding a platform mission's key,
  within the user's authority and refusal beyond it.
- **End to end, acceptance criterion for the cutover**: connect the services the team uses, issue
  one mission per code project, run the daily workflow with a coding agent with no unexpected
  refusal ([e2e-tests](../tests/e2e-tests.md)); by hand, outside the automated suite.
- **Structural**:
  - no telemetry report, of either level, contains a forbidden field (§9), and the instance
    identifier travels with the instance profile only;
  - mission log counters agree with the audit;
  - no configuration value is hard-coded;
  - every persisted restriction and `accepted_risks` is an enumerated list, never a wildcard, never
    a preset reference;
  - every risk catalog groups each of its risks but the fallback in exactly one macro-action, and no
    risk catalog ships presets;
  - a user's authority on an account is recomputed from their current group membership, never from
    a snapshot;
  - the git remote admits with the execution door's own admission.
- **Out of scope**: integration tests against real services.
