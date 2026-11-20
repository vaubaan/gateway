---
name: vaubaan-credential
description: Use after vaubaan-classify, to write src/credential.ts, how a person connects an account of the service: the kind of credential, its guide and verify, the check run when it is pasted. Stops for the human on the credential choice.
---

# Write the credential

The same step for a person, with its reasons: https://vaubaan.com/docs/plugins-guide/credential (append `.md` to the path for Markdown). Read it when a rule below is unclear; this skill decides what you do and where you stop.

You declare **how** an account is obtained; the gateway runs the form, stores the secret encrypted
and hands it to `execute` for one call at a time. The plugin writes no route, never reads the
environment, never sees an OAuth client secret. One way of connecting per plugin.

## Inputs

- The service's documentation of its tokens: where a person makes one, the permission names that
  page shows, how a token expires, the "who am I" endpoint.
- The tools of `src/tools.ts`: every tool must be served by one permission of the guide.

## Steps

1. List what the service offers, from its documentation: personal tokens, scoped or fine-grained
   tokens, project or organization keys, service accounts, OAuth. For each: where it is made, what
   it reaches, which permissions it carries, how it expires, how it is revoked.
2. **Stop for the human** (below). Do not write the file before their answer.
3. Write `src/credential.ts` for the chosen kind:
   - `api-key` (the default: a key a person makes by hand): `label` (what the person creates, in
     the service's words, lower case), `createUrl` (the token page itself, not the dashboard),
     `fields` (the secret field named in `src/identity.ts`, `secret: true`, `required: true`, a
     `pattern` a real key matches, `help`), and the `guide`:
     - `steps`: `{ do, path?, url?, code? }`, one imperative sentence each, in order, the last one at
       the paste; the menus to follow in `path`, in the service's own labels;
     - `reach: { what, grant, why }`: the grant the human chose and why (each mission narrows it);
     - `permissions`: `{ name, access, tools }` as the service's page names them, every tool in one;
     - `expiry`: `{ kind: 'service-reports' }` when `verify` reads it, `{ kind: 'person-types',
       recommendedDays }` when the person picks it, `{ kind: 'none', reason }` otherwise;
     - `docsUrl`: the service's page on this kind of token.

     A key that comes in several shapes declares `alternatives` (2 to 4), the narrowest that fits
     the missions first, and says why in `reach.why`.
   - `oauth2`: only when the service has no key a person can make **and** registers clients
     dynamically (`clientRegistration.registrationUrl`), or through an OAuth broker the instance is
     enrolled with (`broker: { provider }` and `scopes`, nothing else). Set `refreshable: true` when
     the token endpoint issues refresh tokens.
4. Write `verify(ctx)`: one call to the service's "who am I" endpoint through the same `request`
   helper `execute` uses (in `src/execute.ts`; set its authentication header to what the service
   expects). Return `{ account, expiresAt }`: the name the token acts as, the expiry when the
   service says it. A cause you can name (wrong token type, missing permission) throws
   `new CredentialRefusal('<your sentence>')` from `@vaubaan/plugin-sdk`: your words, at most 300
   characters, never the service's text nor the token. A rejected token is the
   `UpstreamAuthError` the transport throws by itself.
5. In `src/index.ts`, set `manualRevocation` (where the person deletes the token), or declare
   `revocation` / `revoke(ctx)` when the service has an endpoint for it.
6. Rewrite `tests/unit/credential.test.ts`:
   - the guide: `createUrl`, the grant, a step's words, through `guideText(guide)` from
     `@vaubaan/plugin-sdk/testing`;
   - `verify` against `mockFetch([...])`: the account named, the header sent, a 401 rejected as
     `UpstreamAuthError`, each `CredentialRefusal` you throw.
7. Update the credential expectation of the structural kit (`tests/unit/plugin.test.ts`, "tool
   names are derived from the service id") if the kind or the field changed.

## Stop for the human: the credential choice

Show the human, in a few lines:

- the kinds of credential the service offers, and the one you propose (the simplest a person can
  make, never an OAuth app or a service account when a pasted key does the job);
- the grant you propose: the widest the service offers for what the account connects, since every
  mission narrows it; or, where a key can be confined to one project, the narrow one first;
- the permissions to tick, each with the tools it serves;
- the expiry you recommend.

Ask them to choose. Write what they chose. Never ask for, store or print a real token.

Done when: `npx vitest run tests/unit/credential.test.ts` exits 0.
