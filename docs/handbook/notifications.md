---
title: Notifications
tracks:
  - apps/gateway/src/server/notifications/
  - apps/gateway/src/server/crypto/web-push-message.ts
  - apps/gateway/src/server/store/repositories/notification-devices.ts
  - apps/gateway/migrations/0030_notification_devices.sql
  - apps/gateway/public/sw.js
  - apps/gateway/src/app/manifest.ts
  - apps/gateway/src/lib/notifications/
  - apps/gateway/src/components/notifications/
  - apps/gateway/src/app/(app)/settings/notifications/
  - apps/gateway/src/app/api/notifications/
last_reviewed: 2026-11-02
---

# Notifications — handbook

The person's devices, the events that notify them and the web push that reaches them (wave 1:
channel kind "device" only). Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2 bis; ADR
[notifications-reach-the-persons-own-channels](../decisions/notifications-reach-the-persons-own-channels.md).

## Start here

- [`events.ts`](../../apps/gateway/src/server/notifications/events.ts) — the port each module calls after its write; `NO_NOTIFICATIONS` by default.
- [`dispatch.ts`](../../apps/gateway/src/server/notifications/dispatch.ts) — who each event reaches and what it says.
- [`notifier.ts`](../../apps/gateway/src/server/notifications/notifier.ts) — the `Notifier` contract; a wave-2 channel kind joins `fanOut` in [`index.ts`](../../apps/gateway/src/server/notifications/index.ts).
- [`web-push/`](../../apps/gateway/src/server/notifications/web-push/) — RFC 8292 VAPID with `jose`, the transport, the push-service list; the RFC 8291 encryption is [`crypto/web-push-message.ts`](../../apps/gateway/src/server/crypto/web-push-message.ts) (ciphers live in the crypto module only). No `web-push` package.
- [`public/sw.js`](../../apps/gateway/public/sw.js), [`lib/notifications/push-client.ts`](../../apps/gateway/src/lib/notifications/push-client.ts) — the browser side.

## Invariants

- **The dispatch points**, each called after its commit, never awaited: `budget/session-service.ts` (`notifyOpened`, a claim or approval request this call created, not one found open), `execution/permission-request.ts`, `connections/credentials.ts` (only the call whose `markExpired` made the transition), `authority/mission-grounds.ts` (`settle`, so every act that orphans is covered, sign-ins and deactivations included), `missions/mission-service.ts` `revoke`. The dispatch drops a mission orphaned or revoked by its own creator: they know, `backup/scheduled.ts`, `auth/recovery.ts`.
- **A payload carries no argument**: `notification.ts` has no field for one, the builder is pure, and a property test feeds arbitrary arguments through a refusal. Never add a field of the call to `NotificationBody`.
- **Best effort, at once, once**: `background.ts` runs at most 4 deliveries, drops past 1000 waiting, never retries. `404`/`410` drops the device (`gone`); any other failure only stamps `last_failure_*`. Nothing reaches the executor.
- **The endpoint is a capability URL**: sealed in `subscription_blob`, never logged, audited or shown; rows dedupe on its SHA-256, so a person subscribing on a shared browser takes the device over (a `device-removed` entry lands in the former person's trail). At most `DEVICES_MAX` (20) live devices per person: each notification posts to every one.
- **"This device receives your notifications" is the server's word**: the page hands the browser the SHA-256 of the person's live endpoints, and a browser subscription not among them reads `available` (removed, dropped, taken over). A post the gateway refuses unsubscribes what was made for it.
- **The VAPID pair** (`instance_config` `notifications.vapid`) is generated the first time it is needed (the Settings page, the home's proposal or a send), never at the boot: a command that builds a root (the v4 import's dry run) writes nothing. Sealed, resealed by `reseal` with every instance secret. Never regenerate it: every stored subscription was made with its public half.
- Endpoints outside `PUSH_SERVICE_HOSTS` (`web-push/push-services.ts`) are refused at add and again before each send: no request to an address a signed-in person typed.

## Traps

- **iPhone and iPad** receive push only in the interface added to the Home Screen (iOS 16.4+): `navigator.standalone === false` reads `install-first`, and the page offers nothing else.
- **`strict-dynamic` drops `'self'`** from `script-src`: without `worker-src 'self'` (`http/security-headers.ts`) the registration of `/sw.js` is blocked.
- **The service worker must never cache** nor listen to `fetch`: every page carries authorization (`tests/unit/app/service-worker.test.ts`).
- **Push needs an https public URL** (a secure context in the browser; `sub` of the VAPID token is the public origin): the boot logs `public_url is not https` otherwise.
- **An air-gapped instance cannot reach the push services**: every delivery fails and is only logged; open the hosts of [configuration](configuration.md) in an egress allowlist.
- `auth` and `instance` are built after this module in `compose/root.ts`; the dispatch reads them through closures, at send time only.
- `PushOffer` needs the toast provider of the shell: the home renders it only when it has a key.

## Debug

- **Nothing arrives, no log** → no device listed in Settings, or the person is deactivated.
- **`notification not delivered` with `status: no answer`** → the push service is unreachable (egress), or the stored pair does not open (boot log `stored secrets do not open`).
- **`status: 403`** → the device subscribed with another key pair (a store restored from elsewhere): remove and subscribe again.
- **A device reads "dropped"** → its browser unsubscribed or expired the subscription; subscribe again from it.
