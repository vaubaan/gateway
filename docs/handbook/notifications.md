---
title: Notifications
tracks:
  - apps/gateway/src/server/notifications/
  - apps/gateway/src/server/crypto/web-push-message.ts
  - apps/gateway/src/server/store/repositories/notification-devices.ts
  - apps/gateway/src/server/store/repositories/notification-addresses.ts
  - apps/gateway/src/server/store/repositories/notification-mail.ts
  - apps/gateway/src/server/http/public-address.ts
  - apps/gateway/migrations/0030_notification_devices.sql
  - apps/gateway/migrations/0031_notification_addresses.sql
  - apps/gateway/migrations/0032_notification_mail.sql
  - apps/gateway/public/sw.js
  - apps/gateway/src/app/manifest.ts
  - apps/gateway/src/lib/notifications/
  - apps/gateway/src/components/notifications/
  - apps/gateway/src/app/(app)/settings/notifications/
  - apps/gateway/src/app/api/notifications/
last_reviewed: 2026-11-16
---

# Notifications — handbook

The person's channels, the events that notify them and what reaches them: devices (web push),
messaging addresses (a service's incoming webhook) and mail. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2 bis; ADR
[notifications-reach-the-persons-own-channels](../decisions/notifications-reach-the-persons-own-channels.md).

## Start here

- [`events.ts`](../../apps/gateway/src/server/notifications/events.ts) — the port each module calls after its write; `NO_NOTIFICATIONS` by default.
- [`dispatch.ts`](../../apps/gateway/src/server/notifications/dispatch.ts) — who each event reaches and what it says.
- [`notifier.ts`](../../apps/gateway/src/server/notifications/notifier.ts) — the `Notifier` contract and the device and address notifiers; [`mail-channel.ts`](../../apps/gateway/src/server/notifications/mail-channel.ts) the mail one; all joined by `fanOut` in [`index.ts`](../../apps/gateway/src/server/notifications/index.ts).
- [`messaging/`](../../apps/gateway/src/server/notifications/messaging/) — `address-rules.ts` (which URL per kind), `destination.ts` (public internet only), `messages.ts` (each service's body), `transport.ts` (the POST). [`address-service.ts`](../../apps/gateway/src/server/notifications/address-service.ts) adds after the test message; [`channel-handlers.ts`](../../apps/gateway/src/server/notifications/channel-handlers.ts) the three form routes.
- [`web-push/`](../../apps/gateway/src/server/notifications/web-push/) — RFC 8292 VAPID with `jose`, the transport, the push-service list; the RFC 8291 encryption is [`crypto/web-push-message.ts`](../../apps/gateway/src/server/crypto/web-push-message.ts) (ciphers live in the crypto module only). No `web-push` package.
- [`public/sw.js`](../../apps/gateway/public/sw.js), [`lib/notifications/push-client.ts`](../../apps/gateway/src/lib/notifications/push-client.ts) — the browser side.

## Invariants

- **The dispatch points**, each called after its commit, never awaited: `budget/session-service.ts` (`notifyOpened`, a claim or approval request this call created, not one found open), `execution/permission-request.ts`, `accounts/credentials.ts` (only the call whose `markExpired` made the transition), `authority/mission-grounds.ts` (`settle`, so every act that orphans a mission or takes an account from one that keeps running — `mission-account-lost`, once its audit entry is written — is covered, sign-ins and deactivations included), `missions/mission-service.ts` `revoke`. The dispatch drops a mission orphaned, revoked or losing an account by its own creator's act: they know, `backup/scheduled.ts`, `auth/recovery.ts`.
- **A payload carries no argument**: `notification.ts` has no field for one, the builder is pure, and a property test feeds arbitrary arguments through a refusal. Never add a field of the call to `NotificationBody`.
- **Best effort, at once, once**: `background.ts` runs at most 4 deliveries, drops past 1000 waiting, never retries. `404`/`410` drops the device (`gone`); any other failure only stamps `last_failure_*`. Nothing reaches the executor.
- **The endpoint is a capability URL**: sealed in `subscription_blob`, never logged, audited or shown; rows dedupe on its SHA-256, so a person subscribing on a shared browser takes the device over (a `device-removed` entry lands in the former person's trail). At most `DEVICES_MAX` (20) live devices per person: each notification posts to every one.
- **"This device receives your notifications" is the server's word**: the page hands the browser the SHA-256 of the person's live endpoints, and a browser subscription not among them reads `available` (removed, dropped, taken over). A post the gateway refuses unsubscribes what was made for it.
- **The VAPID pair** (`instance_config` `notifications.vapid`) is generated the first time it is needed (the Settings page, the home's proposal or a send), never at the boot: a command that builds a root (the v4 import's dry run) writes nothing. Sealed, resealed by `reseal` with every instance secret. Never regenerate it: every stored subscription was made with its public half.
- Endpoints outside `PUSH_SERVICE_HOSTS` (`web-push/push-services.ts`) are refused at add and again before each send: no request to an address a signed-in person typed.
- **A messaging address is kept only after its test message got a 2xx**, posted synchronously by the add route; otherwise the page reads `?problem=test-failed&status=<n>`, never the URL. The URL is sealed in `url_blob` (`SEALED_COLUMNS`), deduped per person on its SHA-256, at most `ADDRESSES_MAX` (10); the list, the audit (`address-added`, `address-removed`) and the logs carry id, kind and label only. A failure at send stamps `last_failure_*`; nothing drops an address.
- **Egress of an address**: https, no credentials, no redirect followed, 10 s. `slack`, `teams`, `discord` must be on the vendor's hosts (`VENDOR_HOSTS`, default port). `ntfy` and `generic` are free hosts: `localhost`, an IP literal outside the public internet, or a name with ANY record outside it is refused (`http/public-address.ts`, shared with the OAuth client metadata documents), at add and again before each send; the vendors' hosts are not resolved.
- **What a channel receives is `buildPayload` only**: title, body, url (made absolute with `public_url`); the generic body adds `kind` and `instance`, the mail a fixed subject per kind and one footer line. The property test of `notifications.test.ts` checks every channel's outgoing text.
- **Mail is a channel only with a mailer that sends notices** (`LinkMailer.sendNotice`, the `mail.*` relay) and once the person switched it on (`notification_mail`, a row is on; audited `mail-notifications-changed`). The address is `users.email`, read at send, never copied. `RootDeps.notificationMailer` replaces the mailer for notifications only (the e2e instance).
- **Administration → People counts channels** (`channelCounts`): live devices, addresses, and mail when on and deliverable; never which.

## Traps

- **iPhone and iPad** receive push only in the interface added to the Home Screen (iOS 16.4+): `navigator.standalone === false` reads `install-first`, and the page offers nothing else.
- **`strict-dynamic` drops `'self'`** from `script-src`: without `worker-src 'self'` (`http/security-headers.ts`) the registration of `/sw.js` is blocked.
- **The service worker must never cache** nor listen to `fetch`: every page carries authorization (`tests/unit/app/service-worker.test.ts`).
- **Push needs an https public URL** (a secure context in the browser; `sub` of the VAPID token is the public origin): the boot logs `public_url is not https` otherwise.
- **An air-gapped instance cannot reach the push services**: every delivery fails and is only logged; open the hosts of [configuration](configuration.md) in an egress allowlist.
- `auth` and `instance` are built after this module in `compose/root.ts`; the dispatch reads them through closures, at send time only.
- `PushOffer` needs the shell's `ToastProvider`: the home renders it only when it has a key.
- **Teams: Workflows, not the Office connectors.** Microsoft retired the Office 365 connectors (`*.webhook.office.com`); a Workflows trigger ("When a Teams webhook request is received", `*.logic.azure.com` or `*.environment.api.powerplatform.com`) takes the `{ type: "message", attachments: [Adaptive Card] }` body and answers 202. An old connector URL is still accepted and may answer an error: the test message says so at once.
- **ntfy self-hosted on a private network is refused** (that is the point of the private-range check): only a server on the public internet, or ntfy.sh, is reachable. A protected topic needs a token, which an address cannot carry (no credentials in the URL).
- **A free host is reached through `publicOnlyPoster`** (`messaging/posters.ts`: `node:https`, the socket handed only the public addresses of one resolution, the peer checked again), not `fetch`: a name re-pointed inside the network after the check is refused at the socket (DNS rebinding). Injecting `fetch` (`RootDeps.notificationFetch`, tests and the e2e instance) replaces that socket too.
- **Slack answers 404/410** for a revoked webhook or an archived channel: recorded as a failure, never dropped; the person removes it.
- The `$schema` URL of the Teams card is allow-listed in `no-hardcoded-config.test.ts` (an identifier, never fetched).

## Debug

- **Nothing arrives, no log** → no device listed in Settings, or the person is deactivated.
- **`notification not delivered` with `status: no answer`** → the push service is unreachable (egress), or the stored pair does not open (boot log `stored secrets do not open`).
- **`status: 403`** → the device subscribed with another key pair (a store restored from elsewhere): remove and subscribe again.
- **A device reads "dropped"** → its browser unsubscribed or expired the subscription; subscribe again from it.
- **An address shows "no answer"** → egress closed to that host, a redirect, a timeout, or (ntfy, generic) its name now resolves inside a private range: the log line `notification not delivered` carries `address_kind` and `status` (`refused: private-destination`…), never the URL.
- **"This instance does not deliver mail"** → no `mail.*` configured; the sign-in accounts' links are then shown to the administrator too.
