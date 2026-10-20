---
title: A backup carries the sign-in providers and the admin rule set by the environment
status: accepted
date: 2026-10-20
extends:
  - restore-verifies-before-it-replaces-and-runs-at-first-boot
  - sign-in-providers-admission-and-admin-rule
  - master-key-rotation-reseals-every-blob
---

# A backup carries the sign-in providers and the admin rule set by the environment

## Context

The `backup` command copies the store (`VACUUM INTO`). The sign-in providers
set by the mounted file or the environment (`idp.*`, `sign_in.<id>.*`) and the
admin rule (`admin.group`, `admin.emails`) are not in the store, so they are
not in the copy. A restore on another host brings every user, mission and
connection back, and nobody can sign in the way they used to: on 2026-10-19 a
restored Fiabilis instance had its Entra provider re-entered by hand. The
managed offer asked for it (request 17 of its spec, `managed-instances.md`
§10.2), and a self-hoster moving a host has the same problem.

## Decision

1. **The copy, not the live store, receives them.** After `VACUUM INTO`, the
   command opens the copy (read-write, no migration) and writes every provider
   the configuration sets as a store-held provider, the way Administration →
   Identity provider saves one: `sign_in.<id>` (settings as JSON) and
   `sign_in.<id>.client_secret` sealed by the master key with associated data
   `instance_config:sign_in.<id>.client_secret`; the provider `idp` in the
   single-provider keys (`idp.*`). The running instance's store is never
   written, so its precedence rules are unchanged. The command prints the ids
   it carried, never a secret.
2. **What a store-held provider keeps grows to what the file can say.** Its
   JSON now keeps `require_verified_email` and `claims.email_verified`, so a
   carried Entra provider still requires a verified email (ADR
   verified-email-for-a-company-directory). Editing it in the form keeps both:
   the form does not show them, and an edit must not weaken admission.
3. **Precedence on the new host: its environment wins on an id collision.** A
   carried provider is a store-held provider, and the existing rule already
   says the file wins over the store for one id (ADR
   sign-in-providers-admission-and-admin-rule). The store copy is kept,
   hidden, and comes back if the environment stops setting that id. Providers
   of different ids add up: the new host's (the managed offer adds Vaubaan's)
   on top of the carried ones.
4. **The admin rule is carried as one key, `restored.admin_rule`**, JSON
   `{ group, emails }`, the group qualified with its provider
   (`<provider>:<group>`) against the providers of the source, so that it does
   not become ambiguous when the new host adds a provider. At boot the
   effective rule is the environment's rule plus the carried one: the emails
   are the union; the group is the environment's when it sets one, the carried
   one otherwise (one group per rule today; a carried group dropped for that
   reason is said at `warn` at boot). The environment still has to give an
   admin rule at boot. A backup of a restored instance carries the merged
   rule. Removing the carried rule is deleting that key; moving the
   administrators into the store (request 20 of the managed offer) will
   replace this key, which is why it is kept this small.
5. **The export carries the same.** The export from the instance (a fresh
   backup plus a manifest, request 7) does not exist in the gateway yet; it is
   defined as a backup, and will call the same writer
   (`SignInProvidersService.carryIntoStore`).

### Amendment 2026-10-20 — the administrators supersede the carried rule

ADR [administrators-live-in-the-instance](administrators-live-in-the-instance.md)
moves the administrators into the store, so D4 changes: the `backup` command no
longer writes `restored.admin_rule` (the administrators are rows of the copy),
and the boot no longer merges a carried rule into the configured one. A copy
made by a build of D4 is still read: while the restored store names no
administrator, the boot applies its carried rule with the configuration's —
both groups, every email — as designations, then deletes the key; a store that
already names administrators drops the key unread. D1, D2, D3 and D5 hold.

## Consequences

- A restore on a fresh host signs people in as before, with the old host's
  providers editable from Administration → Identity provider, provided the
  identity provider accepts the new host's callback address (a redirect URI is
  registered per public URL; that stays the operator's step).
- A backup now holds the client secrets of the environment's providers, sealed
  like every other stored secret: the copy already needed the master key to be
  of any use; it holds nothing in clear that it did not before.
- The backup writes to the copy, so the copy is no longer byte-for-byte what
  `VACUUM INTO` produced; its integrity check runs after the writes.
- A provider removed from the environment of the source after a backup still
  comes back with that backup: the backup is a picture of the moment.

## Rejected alternatives

- **The new host's carried provider wins over its environment.** It would
  let a backup silently override what the operator configures now; the store
  never wins over the file anywhere else.
- **Writing the environment's providers into the live store at every boot.**
  Simpler for the backup, but it would turn every file provider into a stored
  one on the source too, and a provider removed from the environment would
  survive in the store.
- **A side file (a manifest beside the copy) holding the providers.** Two
  files to keep together, and secrets to seal outside the store; the restore
  would need to learn a second format.
- **Carrying several admin groups (a list).** The admin rule holds one group
  today; widening it touches every page and check of the rule, while request
  20 replaces the rule by administrators kept in the store.
