---
title: Connect Google Calendar without my own Google client
status: proposed
actors: [consultant, team-lead]
spec: [../spec/oauth-broker.md, ../spec/vaubaan-gateway.md]
last_reviewed: 2026-11-22
---

# Connect Google Calendar without my own Google client

As a user of a hosted instance, I want to sign in to Google Calendar through
Vaubaan's broker, so that I connect my agenda without creating an OAuth client at Google. An instance on my
computer needs no broker: it carries Vaubaan's own Google client
([run Vaubaan on my computer](run-vaubaan-on-my-computer.md)).

## Sign in to Google Calendar through Vaubaan's broker

status: proposed
relieves: my-own-google-client-to-create
requires: instance, broker
creates: flow
spec: ../spec/oauth-broker.md#2-what-it-does
acceptance:

- Google's consent screen names Vaubaan on the verified domain vaubaan.com, asks the two calendar scopes only, and shows no "unverified app" warning
- An instance enrolled with Vaubaan's broker connects a Google Calendar account and its agent lists that account's events
- While the broker runs without an enclave, the account page says the account signed in through an unattested broker

## Enrol my instance with Vaubaan's broker at first launch

status: proposed
relieves: my-own-google-client-to-create
requires: instance, broker
spec: ../spec/oauth-broker.md#4-trust-model
acceptance:

- A new hosted instance connects Google Calendar with no step by its administrator or by the operator
- The broker restarts or redeploys without ending any enrolled instance's account
- A call with a key the broker never issued is refused with `invalid_key`, and never reaches another instance's flow

## Check the broker's code before signing in

status: proposed
requires: broker, enclave, measurement
spec: ../spec/oauth-broker.md#4-trust-model
acceptance:

- Vaubaan's broker answers `/attest` from Confidential Space with a measurement the current gateway release admits
- The account page of an account connected after the switch says it signed in through an attested broker
- An account connected while the broker was unattested keeps working after the switch, or the page says what to reconnect
