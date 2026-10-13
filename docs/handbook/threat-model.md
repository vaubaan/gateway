---
title: Threat model — who can do what to an instance, and what answers it
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/tests/unit/structural/
  - apps/gateway/src/server/auth/cookies.ts
  - apps/gateway/src/server/auth/claims.ts
  - apps/gateway/src/server/auth/guard.ts
  - apps/gateway/src/server/auth/authenticator.ts
  - apps/gateway/src/server/users/
  - apps/gateway/src/server/shares/service.ts
  - apps/gateway/src/server/authority/
  - apps/gateway/src/server/oauth-as/delegations.ts
  - apps/gateway/src/server/oauth-as/management-gate.ts
  - apps/gateway/src/server/management/tools.ts
  - apps/gateway/src/server/execution/door.ts
  - apps/gateway/src/server/execution/token-verifier.ts
  - apps/gateway/src/server/http/client-ip.ts
  - apps/gateway/src/server/compose/root.ts
  - packages/gateway-core/src/fingerprint.ts
  - packages/gateway-core/src/pipeline.ts
  - deploy/docker/smoke.sh
  - scripts/audit-gate.mjs
  - .github/audit-allowlist.json
---

# Threat model — who can do what to an instance, and what answers it

What the gateway defends, against whom, with which control, and which test
proves the control is still there. It is the security reading of the
specification ([vaubaan-gateway](../spec/vaubaan-gateway.md) §2.4, §3, §6) and
of the handbooks of each surface; it adds no rule of its own. Every control
below names its proof: a test file, or an invariant of the structural suite
(`apps/gateway/tests/unit/structural/manifest.ts`, cited between brackets as `inv:` followed by the invariant’s id),
whose index test fails when a proof disappears.

How to report a vulnerability: [`SECURITY.md`](../../SECURITY.md).

## The trust proposition

**One instance, one company, one trust domain.** The gateway runs inside the
company that uses it, on its hardware, behind its TLS terminator, with its
identity provider. Everything it holds belongs to that company.

It follows that:

- **The operator is trusted.** Whoever runs the process holds the master key
  and can read a decrypted provider credential in the memory of a running
  call. The gateway does not defend against its own operator, and no control
  below should be read as doing so. It does make the operator's acts
  **visible** (every administrative act is audited) and keeps their role
  **narrow** in the product: an operator configures, approves OAuth clients,
  keeps local groups, deactivates users and reassigns ownerless connections;
  they do not read arguments, decide requests of other users, or issue
  missions on connections they do not hold.
- **The identity provider is trusted for identity.** Who a human is, and
  which groups the IdP says they are in, is taken from a signed ID token.
  Authorization is local: what a user may do is computed on the instance from
  ownership, shares and current memberships.
- **A provider plugin is trusted code.** A plugin ships in the image, is
  reviewed like the rest of it, and its classifier decides which risks a call
  touches: a classification error is a vulnerability, not a bug. The provider
  behind it is **not** trusted (see "A compromised or hostile provider").
- **Agents are not trusted.** An agent holds a mission token and nothing
  else. Everything it sends — tool name, arguments, headers, label — is
  attacker-controlled input.

The reasoning for storing credentials decryptable by the instance is the ADR
[trust-model-clear-at-rest-idp-style](../decisions/trust-model-clear-at-rest-idp-style.md);
moving the instance from a SaaS into the company is what makes that
proposition acceptable for production credentials
([pivot ADR](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)).

## Actors

| Actor                               | Holds                                                                   | Trusted for                                                        | Must not be able to                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Operator**                        | the host, the configuration, the master key; the admin rule in the IdP  | everything the process can do                                      | act without a trace; be designated by anything but the configuration's admin rule                                           |
| **Connection owner**                | a connection (alone, or as a current member of the owner group)         | the provider's full catalog on that connection; sharing it         | keep ownership after leaving the owner group; touch a connection they do not own                                            |
| **Beneficiary**                     | a share (direct, or through a group)                                    | the restriction of the share, as an explicit list                  | exceed the restriction; share further; keep authority after the share is revoked or narrowed                                |
| **Mission creator**                 | missions they issued; the requests those missions raise                 | issuing within their authority; answering their missions' requests | issue beyond their authority; keep a mission serving once the authority behind it is gone; decide another creator's request |
| **Executor** (agent)                | a mission token                                                         | calling tools within the mission's risks, resources, budget, gates | see a provider credential; exceed the mission; approve or claim for itself; change its mission; use the other two surfaces  |
| **Delegated client** (MCP client)   | a delegated access token and a refresh token                            | reading the user's authority; issuing missions in the user's name  | execute a tool; answer a request; open a gate; touch connections or shares; obtain a mission token it was not issued        |
| **Outside attacker**                | network reach to the instance (it is on the company network or exposed) | nothing                                                            | everything: read, authenticate, exhaust, or make a signed-in user act                                                       |
| **Compromised or hostile provider** | the provider's API responses; possibly a stolen provider credential     | nothing                                                            | inject content that changes a decision; learn anything of the instance beyond the call it serves                            |

A person can be several of these at once (an operator who owns connections
and issues missions). The roles do not merge: an operator's session decides
no request it does not own, and matching the admin rule adds Administration,
nothing on the domain.

## Assets

| Asset                                                    | Where it lives                                                     | What protects it at rest                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Provider credentials (tokens, keys, app private keys)    | `connections.credential_blob`, `instance_config` secrets           | XChaCha20-Poly1305, one key per row derived from the master key, the row id as associated data |
| The master key                                           | the configuration (environment or a mounted file), never the store | the host's own controls; a database copy without it opens nothing                              |
| Mission tokens                                           | shown once at issuance; `mission_tokens.hash`                      | argon2id hash; looked up by a non-secret prefix                                                |
| Delegated access and refresh tokens, authorization codes | shown once; `oauth_*` tables                                       | SHA-256 digest (256-bit random values)                                                         |
| Web sessions                                             | a cookie; `web_sessions`                                           | the row key is the SHA-256 of the cookie value                                                 |
| Sealed arguments of an open approval request             | `requests.args_blob`                                               | same sealing as credentials; erased on decision and on expiry                                  |
| Authority: ownership, shares, memberships, policies      | the store                                                          | explicit rows only (**[inv: enumerations-persisted]**), recomputed at every use                |
| The audit trail                                          | `audit`, `audit_risks`                                             | no update or delete from the application (**[inv: audit-immutable]**)                          |
| Budgets and counters                                     | `session_counters`, `events`                                       | decided and decremented in one transaction (**[inv: counters-agree-with-audit]**)              |

Backups of the store carry every one of these in the protected form above,
and none in clear, **as long as the master key is kept apart from them**.

## The three credentials, and why none crosses

| Credential          | Issued to     | Opens                             | Presented as                    | Never accepted at                       |
| ------------------- | ------------- | --------------------------------- | ------------------------------- | --------------------------------------- |
| **Mission token**   | an executor   | the execution door `/mcp`         | `Authorization: Bearer`         | the management door, the interface      |
| **Delegated token** | an MCP client | the management door `/mcp/manage` | `Authorization: Bearer`         | the execution door, the interface       |
| **Human session**   | a browser     | the interface                     | the `__Host-vbn_session` cookie | either door, as a cookie or as a bearer |

Each door recognises the two credentials that are not its own **by kind**
and answers `wrong-credential-kind` naming the door that accepts them, so a
misrouted agent is told, and a crossing attempt is distinguishable from an
unknown bearer. A request (claim or approval) is decided in a human session
only: the request surface refuses any `Authorization` header before it reads
the session, even next to a valid cookie.

Why it matters: the product's central promise is that **an agent cannot
enlarge itself**. An executor that could also approve its own request, claim
its own budget, or edit its mission would make every budget and gate
decorative. The same agent process may legitimately hold a mission token _and_
a delegated token of its creator (it prepares missions, then executes one);
the separation is what makes that safe:

- the management door **cannot** answer a request, open a gate, extend a
  budget, reset a period, or touch a connection or a share — not by policy
  but by construction: it is handed seven mission methods and static
  catalogs, and nothing else of the instance is reachable from it
  (**[inv: management-door-hard-deny]**);
- it can issue a wider mission, but only within the user's own authority,
  under the user's name, visibly marked as delegated;
- it can rotate — that is, obtain the token of — only a mission its own
  delegation issued (ADR
  [management-door-rotation-scope-and-replay-trace](../decisions/management-door-rotation-scope-and-replay-trace.md)).

Proof: **[inv: three-credentials-never-cross]**
(`apps/gateway/tests/integration/oauth-as/credential-separation.test.ts`),
**[inv: management-door-hard-deny]**.

## Threats and controls, surface by surface

Each row: what an actor could attempt, the control that answers it, and the
test that proves the control. `tests/…` paths are under `apps/gateway/`;
`src/…` paths are under `apps/gateway/src/server/` and name a test beside the
code.

### Sign-in and the web session

| Threat                                                                                                         | Control                                                                                                                                                                         | Proof                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| An attacker replays or forges a sign-in response                                                               | PKCE S256, `state` and `nonce` single use, the ID token validated against the IdP's keys; the callback URL is rebuilt from `public_url`, never from the request                 | `tests/integration/auth/oidc-login.test.ts`                                                       |
| An open redirect through `return_to`                                                                           | only a path of this instance, resolved by the URL parser against `public_url`, checked when stored and again where it becomes a `Location`                                      | `src/auth/handlers.test.ts`, `tests/integration/auth/oidc-login.test.ts`                          |
| A user edits their email at the IdP to match `admin.emails` or the allowed domains                             | a sign-in whose claims say `email_verified: false` is refused before anything is written; `admin.group` is the stronger rule                                                    | `src/auth/claims.test.ts`, `tests/integration/auth/oidc-login.test.ts`                            |
| The IdP omits the groups of a user who has too many (Entra ID overage) and the user silently loses every group | the sign-in is refused (`groups-overage`), nothing is synced                                                                                                                    | `src/auth/claims.test.ts`; `tests/integration/auth/oidc-login.test.ts` ("moved out of the token") |
| A sibling subdomain plants its own session cookie in a colleague's browser (session fixation)                  | `__Host-` cookies: host-only, `Secure`, `Path=/`                                                                                                                                | **[inv: cookies-host-prefixed]**                                                                  |
| Cross-site request forgery on any mutation                                                                     | one guard for every mutating route: `Origin` (or `Referer`) must equal `public_url`'s origin, absent means refused, before the session is even read; cookies are `SameSite=Lax` | **[inv: every-mutation-guarded]**                                                                 |
| A page of Administration is fetched without its layout                                                         | every page and route under `/admin` authorizes by itself                                                                                                                        | `tests/unit/app/admin-guard.test.ts`                                                              |
| A stolen database copy yields live sessions                                                                    | the row key is a digest of the cookie value; sessions last 8 hours, absolute                                                                                                    | `tests/integration/store/web-sessions.test.ts`                                                    |
| A session outlives the authority it was opened with                                                            | nothing is read from the session but the user id: status, groups and the admin rule are read from the store on every request                                                    | **[inv: authority-never-snapshotted]**                                                            |
| A person removed at the IdP keeps their session, their delegations and their missions                          | the operator deactivates them: sign-in refused, sessions over, delegations revoked, missions `orphaned`                                                                         | `tests/integration/auth/deactivate-user.test.ts`                                                  |
| The stored IdP client secret is sent to another issuer                                                         | a blank secret is kept for the same issuer only                                                                                                                                 | `src/auth/idp-settings.test.ts`                                                                   |
| The bootstrap token is used after setup                                                                        | revoked for good at the first operator sign-in; its open sessions are nobody from then on                                                                                       | `tests/integration/auth/oidc-login.test.ts`, `tests/unit/app/admin-guard.test.ts`                 |

### Connections, shares, groups

| Threat                                                                                    | Control                                                                                                                                          | Proof                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| A user reads or acts on a connection or a share by guessing its id                        | every act starts from "the actor owns the connection now"; anyone else reads "not found"; a share is resolved from its own row, not from the URL | `tests/integration/authority/share-and-orphan.test.ts`, `src/shares/service.test.ts`                                       |
| A restriction or a policy says "everything"                                               | ids are checked one by one against the provider's catalog; an empty list is refused; the schema refuses `*`                                      | **[inv: enumerations-persisted]**                                                                                          |
| A beneficiary shares further, or two connections of one provider widen a restricted share | only owners share; authority is asked per connection for every accepted risk                                                                     | `tests/integration/authority/share-and-orphan.test.ts`                                                                     |
| A member of an owner group shares to themselves and keeps authority after leaving         | a share to somebody who owns the connection now is refused                                                                                       | `tests/integration/authority/ownership.test.ts` ("a co-owner cannot keep a share…")                                        |
| A removed member, a revoked or narrowed share, a revoked connection keeps missions alive  | `orphaned` is derived from the creator's current authority on every read and every call                                                          | **[inv: authority-never-snapshotted]**                                                                                     |
| A local group grants operator rights; an IdP claim joins a local group of the same name   | the admin rule counts IdP-sourced groups only; a claim that collides with a local group is skipped                                               | `tests/integration/auth/oidc-login.test.ts`                                                                                |
| The connect flow is replayed, or its return URL leaves the instance                       | single-use `state` bound to the session; return URL limited to `public_url`; per-user rate limit                                                 | `tests/integration/connections/connect-flow.test.ts`, `src/connections/pending.test.ts`, `src/connections/service.test.ts` |
| A provider credential is read from the store, or moved to another connection's row        | sealed per row with the row id as associated data; the record never exposes the ciphertext                                                       | `src/crypto/aead.test.ts`, `tests/integration/store/connections-shares.test.ts`                                            |

### Missions and the execution door

| Threat                                                                      | Control                                                                                                                                                                                                         | Proof                                                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| An agent obtains a provider credential                                      | the credential is decrypted for one call and never returned; refusals, logs and audit carry none                                                                                                                | `tests/integration/execution/door-http.test.ts`, **[inv: no-secret-no-argument-in-logs]**                          |
| A mission is issued beyond the creator's authority                          | the draft is recomputed server-side: unknown, wildcard, base, foreign risk ids and foreign resources are refused whole, with the uncovered list                                                                 | `src/missions/preview.test.ts`, `tests/integration/missions/mission-lifecycle.test.ts`                             |
| A call reaches a resource or a risk the mission did not accept              | resource selection first (`resource-not-in-mission`), then every risk the classifier names must be accepted; a classifier that throws, an unknown tool, a missing catalog, zero risks: all refuse (fail closed) | `tests/integration/execution/pipeline.test.ts`, `packages/gateway-core/tests/unit/pipeline.test.ts`                |
| An argument is crafted so that the call classified is not the call executed | one identifier grammar per plugin, shared by `classify` and `execute`; see "Provider plugins" below                                                                                                             | the plugins' `tests/unit/` (see below)                                                                             |
| Two concurrent calls spend the last credit twice                            | decision and decrement are one transaction                                                                                                                                                                      | **[inv: counters-agree-with-audit]**                                                                               |
| A rotated or revoked token is still accepted (cache)                        | the cache holds the proof that a bearer matched a token row, never the state: token and mission are re-read on every call                                                                                       | `tests/integration/execution/door-http.test.ts` ("verifies the argon2 hash once per token, yet sees a revocation") |
| Wrong secrets on a known prefix burn CPU or lock the agent out              | misses are throttled before the hash, per prefix **and client address**                                                                                                                                         | **[inv: surface-rate-limits]**; accepted residue below                                                             |
| An approval read as one call is spent on another                            | bound to mission, risk, tool and argument fingerprint; single use; arguments JSON cannot carry are rejected before the fingerprint                                                                              | **[inv: approval-binds-what-was-read]**, `tests/integration/requests/approval.test.ts`                             |
| An agent answers its own request                                            | requests are decided by the mission's creator, in a human session, origin-checked; any bearer is refused first                                                                                                  | `tests/integration/requests/approval-access.test.ts`, **[inv: three-credentials-never-cross]**                     |
| A streamed result leaves before the decision                                | parts are emitted from the last stage only, after the budget is charged                                                                                                                                         | `tests/integration/execution/streaming.test.ts`                                                                    |
| The agent label is used to inject or to influence a decision                | shape-checked, rejected rather than repaired, never read by any decision                                                                                                                                        | `tests/integration/execution/agent-label.test.ts`                                                                  |
| A browser page calls the door with a user's cookies                         | any `Origin` other than the instance's is refused; the door requires a bearer and answers no preflight                                                                                                          | `tests/integration/execution/door-http.test.ts`                                                                    |

### The authorization server and the management door

| Threat                                                                             | Control                                                                                                                                                                                      | Proof                                                                                                          |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A hostile client registers and obtains a delegation without the user understanding | a client that redirects anywhere but loopback waits for the operator; the consent screen shows the unverified name, the real destination, what the client can and can never do; never framed | `src/oauth-as/redirect-uri.test.ts`, `src/oauth-as/pages.test.ts`, `src/oauth-as/clients.test.ts`              |
| An authorization code is intercepted                                               | PKCE S256 mandatory, 60 s, single use, bound to client and redirect URI; a failed attempt spends the code                                                                                    | `src/oauth-as/token-service.test.ts`, `src/oauth-as/pkce.test.ts`                                              |
| A refresh token is stolen                                                          | rotation at every use; a replay revokes the whole delegation; the missions it issued are named for review                                                                                    | `src/oauth-as/token-service.test.ts`, `src/oauth-as/delegations.test.ts` ("a delegation revoked for a replay") |
| A disabled client, a deactivated user, a tightened policy keeps a token working    | client standing and user status are re-read at every use of a delegated token                                                                                                                | `src/oauth-as/delegations.test.ts`, `tests/integration/auth/deactivate-user.test.ts`                           |
| A delegated client enlarges the agent it runs                                      | hard deny by construction; rotation limited to its own missions                                                                                                                              | **[inv: management-door-hard-deny]**                                                                           |
| A metadata document fetch is turned into SSRF                                      | off by default; https and a DNS name only, every resolved address public, no redirect, size and time caps, body never reflected                                                              | `src/oauth-as/client-metadata-document.test.ts`                                                                |
| A token minted for the instance is replayed at another resource                    | single scope `mgmt`; RFC 8707 `resource` must be the management door at authorize and at token                                                                                               | `src/oauth-as/authorization.test.ts`, `tests/integration/oauth-as/http-surface.test.ts`                        |

### Audit, logs, telemetry

| Threat                                                              | Control                                                                                             | Proof                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| An act leaves no trace                                              | every mutating service method writes its administrative entry; every call writes one call entry     | **[inv: every-mutation-audited]**             |
| The trail is edited                                                 | triggers refuse `UPDATE` and any `DELETE` outside the retention purge                               | **[inv: audit-immutable]**                    |
| A user reads entries of connections or missions that are not theirs | the audit scope is computed in the store from ownership and creation; a filter never widens it      | `tests/integration/audit/audit-query.test.ts` |
| Arguments or secrets reach a log or the audit                       | arguments by fingerprint only; tokens by prefix; a redactor removes every configured secret         | **[inv: no-secret-no-argument-in-logs]**      |
| Telemetry leaks what an instance does                               | opt-in; six frozen fields rebuilt key by key; no instance identifier; nothing queued while disabled | **[inv: telemetry-shape]**                    |

### Build, image, supply chain

| Threat                                                     | Control                                                                                                             | Proof                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A vulnerable dependency ships                              | `npm audit --omit=dev` gates CI and releases, against a reviewed, dated allowlist                                   | **[inv: dependency-audit-reviewed]**                                |
| The image differs from the commit, or carries test code    | base images pinned by digest; the standalone output carries no test, fixture or demo; smoke test on the built image | **[inv: base-images-pinned]**, **[inv: no-test-file-in-the-build]** |
| A secret is committed or baked into the image              | no literal URL, token or key in the sources; no env file in the image; non-root process                             | **[inv: no-hardcoded-config]**, `deploy/docker/smoke.sh`            |
| A pulled image is not the one the project built            | signed build-provenance attestation, verified with `gh attestation verify`                                          | [`deploy/README.md`](../../deploy/README.md)                        |
| The documented configuration differs from the accepted one | the handbook's key table and the examples are compared with the loader                                              | **[inv: config-examples-match-the-loader]**                         |

### Provider plugins

A plugin turns a tool call into slices (`classify`) and into an upstream
request (`execute`). The gateway decides from the first and runs the second:
**what is executed must be what was classified**, or every decision above is
about another call.

| Threat                                                                                                                              | Control                                                                                                                                                                                                     | Proof                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| An identifier leaves its place in the request: `..` collapses a path to a parent endpoint, a `/` reaches another bucket or resource | one grammar per identifier kind, chosen for where the value lands, shared by `classify` and `execute`; values outside it are refused, never escaped (`encodeURIComponent` does not neutralise `.` and `..`) | **[inv: plugin-identifiers-shared-grammar]**: one test file per plugin, hostile values on both sides                                            |
| `execute` reads an argument differently from `classify` (another default, another field, a coercion)                                | `execute` builds its request from the classifier's own reader, and refuses by itself whatever `classify` would deny                                                                                         | same                                                                                                                                            |
| An identifier arrives from a resource ref, connection metadata or a provider answer rather than from the arguments                  | the same grammars apply to them; a malformed discovered ref is skipped or fails discovery                                                                                                                   | same                                                                                                                                            |
| One string is read by the provider as several values (a recipient list hidden in a display name)                                    | one string is one address; several recipients are an array, each zoned on its own                                                                                                                           | `plugins/resend/tests/unit/addresses.test.ts`                                                                                                   |
| A tool is classified too low (a write read as a read, a protected branch read as ordinary)                                          | each classifier is unit-tested against the provider's documented behaviour; every tool maps to a catalog risk; an unclassifiable call falls to the catalog's fallback risk or is denied                     | each plugin's classifier and catalog unit tests (for instance `plugins/github/tests/unit/classify.test.ts`); `assertCatalogCoverage` of the SDK |
| A shell command is classified on one reading and run on another (SSH)                                                               | the raw command string is both classified and sent, unmodified; anything the lexer cannot read plainly (expansions, globs, redirections) takes the wider class                                              | `plugins/ssh/tests/unit/injection.test.ts`, `plugins/ssh/tests/unit/classify.test.ts`                                                           |
| SQL is classified syntactically and does something else (Supabase)                                                                  | accepted limit, see A16                                                                                                                                                                                     | —                                                                                                                                               |

Rule and reasoning: ADR
[plugin-identifiers-one-grammar-for-classify-and-execute](../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md).

### A compromised or hostile provider

A provider's API is outside the trust domain. What it can do is bounded by
what the gateway does with its answers:

- **It cannot change a decision.** Classification, the risk decision, the
  budget and the gate are computed from the call and the store **before** the
  provider is contacted. Nothing a provider returns is fed back into them.
- **It can return hostile content to the agent** (a prompt injection in an
  issue body, a file, an email). The gateway forwards results as they are:
  it does not sanitise what an agent reads. The defence is the mission
  itself — the injected agent still holds only its mission's risks, budget
  and gates, cannot approve its own gated action, and every call it makes is
  audited. This is the reason gates exist on irreversible risks.
- **It can lie in discovery** (resources that do not exist, misleading
  names). Discovery produces labels and refs an owner curates; a ref the
  provider invents grants nothing until an owner's mission selects it.
- **It can reject or stall.** A rejected credential turns the connection
  `expired` and its calls into `connection-unavailable`; upstream errors are
  summarised by class in the audit and telemetry, never copied verbatim into
  either.
- **A stolen provider credential** is outside what the gateway can see: the
  provider's own logs are the trail. The gateway shortens the exposure where
  the provider allows it (short-lived installation tokens, refresh on
  rejection — [connections](connections.md)) and never hands the credential
  to an agent.

## Accepted risks

Known, decided, and written down so that nobody rediscovers them as bugs.
Each is the residue of a control above, not the absence of one.

| #   | Risk                                                                                                                                                                                                                                                                                                   | Why it is accepted                                                                                                                                                             | What limits it                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **The operator can read decrypted credentials** in process memory, and holds the master key.                                                                                                                                                                                                           | The trust proposition. An instance is its operator's.                                                                                                                          | Administrative acts are audited; the master key is outside the store.                                                                                                                       |
| A2  | **With `trusted_proxies` empty, address-keyed limits are shared.** A flood of wrong secrets on a known token prefix holds a not-yet-verified agent at 429; the request page's per-IP limit is one window for everybody; the audit records no address.                                                  | No address can be believed without a declared proxy, and believing a forged header would be worse. A limit that holds globally is better than one that is bypassed.            | A warning at boot names the key; the reference deployment sets it; a verified agent is never affected. Test: `door-http.test.ts` ("accepted risk: …").                                      |
| A3  | **After a refresh-token replay, missions issued through the delegation keep serving** until the user acts.                                                                                                                                                                                             | The server cannot tell the thief's missions from the honest client's; revoking all would stop running agents on a suspicion.                                                   | The delegation is revoked at once; the entry and the Delegations page list the missions to review.                                                                                          |
| A4  | **Inside the refresh reuse window (30 s) a stolen refresh token replayed once is answered.**                                                                                                                                                                                                           | Two sessions of one agent share a stored refresh token and renew at the same moment; without the window every such race revokes the delegation.                                | One chain only, the immediate predecessor only, same client only; a second reuse revokes. ADR [management-door-authorization-server](../decisions/management-door-authorization-server.md). |
| A5  | **A delegation has no absolute lifetime**: it lives as long as it is renewed within the refresh lifetime.                                                                                                                                                                                              | Forcing a periodic consent is a product decision not taken (question for the owner).                                                                                           | The user revokes in one click; the operator disables the client or deactivates the user; both take effect at the next use.                                                                  |
| A6  | **IdP group changes reach the instance at the user's next sign-in**, not before. The instance has no directory sync.                                                                                                                                                                                   | Identity comes from the ID token; a sync needs SCIM or a directory credential.                                                                                                 | Sessions last 8 hours; local-group edits and deactivation are immediate.                                                                                                                    |
| A7  | **With `oauth.client_registration.policy: open`, `/oauth/authorize` redirects a signed-in user to a registered https URI on a parameter error without a click.**                                                                                                                                       | The policy is the operator's choice; the default (`operator-approved`) does not do it.                                                                                         | Only to a URI the client registered, only for a signed-in user.                                                                                                                             |
| A8  | **The operator can empty a local owner group, then reassign its connections to themselves.**                                                                                                                                                                                                           | Reassignment is the operator's act by design (spec §2.3), and the operator is trusted.                                                                                         | Each step is audited.                                                                                                                                                                       |
| A9  | **The argument fingerprint is an unsalted SHA-256**, readable by connection owners (call entries) and operators: low-entropy arguments can be guessed offline.                                                                                                                                         | Those readers are inside the trust domain and already see what the connection does; keying the hash would break the join between audit rows and requests across key rotations. | Arguments themselves are never stored outside a sealed, short-lived approval request.                                                                                                       |
| A10 | **`-0` and `0` share a fingerprint.**                                                                                                                                                                                                                                                                  | JSON carries both as `0` to the provider.                                                                                                                                      | Non-finite numbers, the case that matters, are rejected.                                                                                                                                    |
| A11 | **A share to a co-owner made before the rule existed still stands.**                                                                                                                                                                                                                                   | No migration judges existing rows.                                                                                                                                             | It is listed in the Share dialog; any owner revokes it.                                                                                                                                     |
| A12 | **An owner may share to a group they also belong to**, and keep that authority after leaving the owner group.                                                                                                                                                                                          | A share to a group is for its other members; the act is a current owner's, visible and audited.                                                                                | Co-owners see and revoke the share.                                                                                                                                                         |
| A13 | **Installation binding proves access, not administration**: a user with read access to one repository of a GitHub App installation can connect it.                                                                                                                                                     | ADR [connect-driver-and-resource-curation](../decisions/connect-driver-and-resource-curation.md).                                                                              | The installation's own permissions bound what the connection can do.                                                                                                                        |
| A14 | **Scope caps of a catalog are not enforced in v5.0.**                                                                                                                                                                                                                                                  | ADR [scope-caps-not-enforced-in-v5-0](../decisions/scope-caps-not-enforced-in-v5-0.md).                                                                                        | No shipped catalog declares one (**[inv: catalog-declares-only-enforced-limits]**).                                                                                                         |
| A15 | **Hostile content in a provider's answer reaches the agent as is.**                                                                                                                                                                                                                                    | The gateway is not a content filter; see "A compromised or hostile provider".                                                                                                  | Risks, budgets, gates, audit.                                                                                                                                                               |
| A16 | **SQL classification is syntactic.**                                                                                                                                                                                                                                                                   | ADR [sql-classification-syntactic-only](../decisions/sql-classification-syntactic-only.md).                                                                                    | The ADR lists what the classifier sees and what it does not; a mission accepting SQL risks accepts that limit.                                                                              |
| A17 | **During a registry outage a merge or release is not audited by that run.**                                                                                                                                                                                                                            | A third-party endpoint must not gate releases. ADR [dependency-audit-gate](../decisions/dependency-audit-gate.md).                                                             | A warning annotation; the previous run on the same lockfile was audited.                                                                                                                    |
| A18 | **Railway: a `serviceId` or a `get-logs deploymentId` is checked for shape, not for belonging to the mission's project.** A mission on one Railway project can name a service or a deployment of another project the same Railway credential reaches; the call is classified on the mission's project. | Discovery stores a project's environments only, so the plugin has nothing local to check against; the lookup needs Railway's API schema and was not guessed.                   | `projectId` and `environmentId` are bound to the mission; the credential's own reach bounds the rest. Open item for the Railway plugin.                                                     |
| A19 | **The SSH classifier models `sh`/`bash`.** If the remote account's login shell is another shell, a command may be read differently there.                                                                                                                                                              | The remote shell is the host owner's choice; the plugin documents the assumption.                                                                                              | Unreadable constructs take the wider risk class.                                                                                                                                            |
| A20 | **Denial of service by an authenticated party** (an agent spending its own budget, a user opening many missions) is bounded, not prevented.                                                                                                                                                            | Rate limits and budgets are per mission, per user, per delegation; a single process on SQLite has finite capacity.                                                             | **[inv: surface-rate-limits]**; the mission's own rate limit per risk.                                                                                                                      |

## Out of scope

- The security of the host, the TLS terminator, the IdP and the provider
  accounts themselves.
- An agent's own behaviour within its mission (what it does with what it is
  allowed to read).
- The legacy v4 application: gone from the tree; its documents under
  `docs/handbook/legacy/` describe a product that is no longer deployed. The
  survey of permission models kept there
  ([permission-threat-model-state-of-the-art](legacy/permission-threat-model-state-of-the-art.md))
  is background reading for the risk model, not a description of this
  instance.

## Keeping this document true

- A new control gets a row **with its proof**; a control without a test is
  written as an accepted risk until it has one.
- A new accepted risk gets a number, a reason and what limits it. Removing
  one means the control now exists: move it to its surface.
- The structural suite's index (`apps/gateway/tests/unit/structural/index.test.ts`)
  fails when an invariant cited here loses its proof; the ids cited as
  **[inv: …]** are the `id`s of `manifest.ts`.

## References

- Specification: [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.4, §3, §6,
  §8, §9, §10; [gateway-risk-model](../spec/gateway-risk-model.md).
- ADRs of the hardening pass:
  [share-to-a-current-owner-refused](../decisions/share-to-a-current-owner-refused.md),
  [management-door-rotation-scope-and-replay-trace](../decisions/management-door-rotation-scope-and-replay-trace.md),
  [operator-deactivates-a-user](../decisions/operator-deactivates-a-user.md),
  [sign-in-hardening-host-cookies-group-overage](../decisions/sign-in-hardening-host-cookies-group-overage.md),
  [execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md),
  [dependency-audit-gate](../decisions/dependency-audit-gate.md).
- Handbooks: [authentication](authentication.md), [authority](authority.md),
  [connections](connections.md), [missions](missions.md),
  [execution-door](execution-door.md), [management-door](management-door.md),
  [requests](requests.md), [audit](audit.md), [store](store.md),
  [configuration](configuration.md), [telemetry](telemetry.md).
