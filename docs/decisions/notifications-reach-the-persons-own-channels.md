---
title: Notifications reach the person's own channels, through no third party the instance registers at
status: accepted
date: 2026-11-02
author: Renaud Pelissier
---

# Notifications reach the person's own channels, through no third party the instance registers at

## Context

A request to the creator waits in the inbox and the executor forwards its URL; in practice the
creator is away from the interface when an agent needs a yes, and an owner learns late that an
account stopped serving. People expect the alert on their phone's lock screen. The instance is
self-hosted and registers nowhere: nothing per provider, and the same must hold per channel.

## Decision

The instance notifies through channels the person adds for themselves and that it reaches outbound
without an account: the interface installed from the browser as the mobile client, its push
subscription signed with a key pair the instance generates; an incoming address of a company
messaging service; the mail delivery already configured. Notification is a host concern behind one
notifier contract, never a plugin or a connection; a notification names, never decides.

## Consequences

- No native mobile application. The installed interface is the mobile client, in the interface's
  words, and must stay installable.
- A new channel kind is a notifier in the host. It needs no authority of the person over a provider
  and must work on an instance that connects nothing.
- A network requiring a business registration and a fee per message is out of the instance; an
  operator wanting it bridges it from the messaging address.
- A notification payload carries nothing a decision could be composed from; the act stays in a human
  session ([spec §6](../spec/vaubaan-gateway.md)).

## Rejected alternatives

### A native mobile application

A store account per platform, a release process and a second client to keep aligned; the installed
interface gives the lock-screen notification with none of it.

### A live connection from the open interface as the channel

It dies when the phone sleeps or the tab closes, which is exactly when the alert matters. It stays
for refreshing an open page.

### Consumer messaging platforms and text messages

A business registration per instance, message templates approved by the network and a fee per
message, incompatible with an instance that registers nowhere.

### Notification channels as provider plugins

A plugin classifies and executes an agent's call with a connection's credential; a notification goes
from the instance to a person and must exist without any connection.

### Approving from the notification

The act would be taken outside a human session and its second factor, on a screen anyone holding the
phone can see.
