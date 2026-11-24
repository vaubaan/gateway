---
title: Authentication
tracks:
  - apps/gateway/src/server/auth/
  - apps/gateway/src/server/users/
  - apps/gateway/src/server/config/sign-in.ts
  - apps/gateway/src/server/crypto/password.ts
  - apps/gateway/src/server/backup/copy.ts
  - apps/gateway/src/app/admin/
last_reviewed: 2026-10-31
---

# Authentication — handbook

Sign-in providers (OIDC, GitHub, sign-in accounts), admission, administrators,
web sessions, the bootstrap token and recovery. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §4.2, §4.3, §6; ADRs
[oidc-relying-party-and-web-session](../decisions/oidc-relying-party-and-web-session.md),
[administrators-live-in-the-instance](../decisions/administrators-live-in-the-instance.md).

## Start here

- [`auth/login.ts`](../../apps/gateway/src/server/auth/login.ts) — `completeLogin`, `currentAuthority`: all a sign-in writes.
- [`auth/admission.ts`](../../apps/gateway/src/server/auth/admission.ts) — who may sign in.
- [`auth/administrators.ts`](../../apps/gateway/src/server/auth/administrators.ts) — designations, seed, drift, `assertNoLockout`.
- [`auth/guard.ts`](../../apps/gateway/src/server/auth/guard.ts) — `guardMutation`, the one mutation guard.
- [`auth/sign-in-providers.ts`](../../apps/gateway/src/server/auth/sign-in-providers.ts) — sign-in providers from the file and from Settings.

## Invariants

- `admit()` runs before anything is written: a refusal creates no user and
  syncs no group. `upsertFromIdp` never changes a status, so an IdP vouching
  never reactivates anyone.
- Operator status is recomputed at every `authenticate()`, never read from the
  session. Only the designated group's own sign-in provider makes a member an
  operator; a local group never does.
- Every human mutation goes through `guardMutation` (origin from `public_url`,
  never forwarded headers); every page and route under `admin/(guarded)`
  authorizes itself, the layout is no boundary. `mutation-guard.test.ts` and
  `admin-guard.test.ts` discover the handlers and fail an unclassified one.
- A mutation without a session answers JSON 401, except a page's form (`Sec-Fetch-Mode:
navigate`, a page left open past its session): 303 to `/login?return_to=<the referring page>`,
  the referer kept only when it is the instance's (`resolveReturnTo`).
- `web_sessions.id` holds the key's SHA-256. The port cannot list a user's
  sessions: ending them all is `users.sessions_ended_at`.
- A stored client secret is never sent to another issuer: a blank secret on
  save keeps the stored one only for the same issuer.
- Passwords: argon2id through the native `argon2` binding (`crypto/password.ts`),
  computed on libuv's thread pool, never on the event loop; libsodium's limits
  (64 MiB, 2 passes, 1 lane). New hashes are written with libsodium's parameter
  order (`m,t,p`), so hashes from before and after verify on either image.
  `checkPassword`: an unknown address and a wrong password cost one hash each; a
  locked account is refused before any hash.
- "Forgot password" answers after the address lookup alone: the reset link
  and its mail are made on `setImmediate`, after the answer, for an existing
  account only; a mail failure is logged, never shown.
- The second factor's step (`PendingLocalStep`) lasts ten minutes from its
  `createdAt`; a wrong code re-issues it with the same `createdAt`
  (`reissueLocalStep`), and `takeLocalStep` refuses an outlived one whatever the
  store's expiry. Wrong codes count per person in `user_second_factors`
  (`SECOND_FACTOR_LOCKOUT`, 10 in 15 min, as `LOCAL_LOCKOUT` for passwords);
  while locked, no code is checked.
- Two kinds of enrolment step, never interchangeable. `enrol` is a sign-in's: the
  sign-in route that takes it (`enrolAtSignIn`) opens a session. `settings-enrol`
  is a signed-in person replacing their factor from Settings: only
  `confirmSecondFactor` takes it, and it keeps the session the person has. A
  shared step would let a stolen session open a fresh one, which the master-key
  download and the factor's removal accept as a recent sign-in. Replacing an
  existing factor, like removing it, needs a session opened in the last ten
  minutes (`FRESH_SIGN_IN_FOR_FACTOR_MS`).
- The codes of the second factor have windows of their own (`AUTH_LIMITS.code*`): a person
  past their password, or their sign-in provider, types the code even while anonymous
  password posts fill the password window. A recovery code is read, checked and spent one
  post at a time per person (`SecondFactors`), so two posts of one code never both pass.
- A password reset by link ends every open session of the person (`users.endSessions`): it
  is what someone does who lost control of the password. A change from Settings, made with
  the current password, keeps them; "Sign out everywhere" is beside it.

## Traps

- **Cookie names depend on the mode**: `__Host-vbn_*` and `Secure` on an https
  instance, plain `vbn_*` without `Secure` in local mode (`cookieJar` in
  `auth/cookies.ts`; Safari and WKWebView drop a `Secure` cookie on
  `http://localhost`). Write and read them through the service's jar, never
  the `SESSION_COOKIE` constants, which name the `host` jar only.

- The callback URL is rebuilt from `public_url` plus the query string, never
  `request.url` (the internal host behind the TLS terminator).
- `groups` is requested only when `scopes_supported` lists it (Google refuses
  unknown scopes). Unreadable groups (userinfo failed, claim absent from the
  ID token) refuse the sign-in: syncing "no group" would strip groups, the
  accounts they own and administrator groups. An Entra overage pointer is
  refused, never followed; Entra sends group object ids.
- `readCookie` matches the name exactly (no `trim()`: ` __Host-…` is another
  cookie a sibling may plant); a name present twice reads as none.
- 50 wrong bootstrap tokens revoke the token for good: anyone can close the
  bootstrap path of an instance with no sign-in provider, so deploy guides set
  the sign-in provider in the configuration first. In setup mode (no store yet) the count
  is the file `setup-misses` next to the key file, so a restart does not reset
  it; it is removed when the setup completes, and deleting it by hand is how an
  operator unlocks a setup that reached 50.
- Entra: designate an administrator group by object id (groups claim "Groups
  assigned to the application"), not an email: tenant User Administrators can
  set `mail`. An email rule needs the optional claim `xms_edov` mapped as
  `claims.email_verified` and `require_verified_email`.
- A sign-in provider saved from Settings stays off until a test passes since its last
  save; the test runs the real flow and writes nothing (no user, session,
  group sync). It starts from a form (`POST /auth/test/<id>`, `guardMutation`,
  in another window), never a link.
- `backup` writes every file/env sign-in provider into the copy (never the live
  store), secrets sealed; on the restoring host its own configuration wins on
  an id collision (the copy stays hidden). `registered_for` flags a
  sign-in provider set up for another host: register the new callback, then
  test.
- Sign-in buttons are never prefetched: a prefetch starts a sign-in.

## Outside the repo

- Each sign-in provider's callback, `<public_url>/auth/callback/<id>`, is
  registered at the IdP, per public URL. The sign-in provider `idp` of earlier
  builds (`idp.*`, then `/auth/callback`) is an ordinary one since 2026-10-31:
  its stored settings are moved at boot (`auth/single-sign-in-provider-upgrade.ts`), its callback is
  `/auth/callback/idp`.

## Procedures

- **Bootstrap lockout** ("no longer available"): set a sign-in provider in the
  configuration and redeploy; or set a new token (32+ characters), delete the
  `instance_config` keys `bootstrap.revoked_at` and `bootstrap.misses` from a
  shell in the container (`vaubaan-entrypoint node -e …` over
  `better-sqlite3` at `VAUBAAN_STORE_PATH`), restart.

## Debug

- **`too-many-attempts` for everyone** → no client address known, the
  instance window is full: it slides in ten minutes, or restart (in-memory). The code of the
  second factor has its own window: a person already past the password is not stopped.
- **Boot exit 78 on `bootstrap_token`** → no administrator, no token, no admin
  rule: no way in.
- **`second-factor-locked`** → ten wrong codes in fifteen minutes: wait
  fifteen minutes, or an administrator resets the person's second factor.
- **`groups-overage`** → limit the claim to groups assigned to the
  application, or map `claims.groups` to a complete claim.
