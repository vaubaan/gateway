---
title: Bring my team onto Vaubaan
status: proposed
actors: [team-lead, developer, teammate, security-reviewer]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-22
---

# Bring my team onto Vaubaan

As a person who started alone, I want to move my work to a server my team shares and welcome my
teammates there, so that adopting Vaubaan as a team never means starting over.

## Take the team's instance over

### Take over my instance and its master key

status: implemented
requires: instance
anchors: apps/gateway/src/server/master-key/service.ts, apps/gateway/src/server/setup/handlers.ts, apps/gateway/tests/integration/instance/master-key-handover.test.ts, apps/gateway/tests/integration/compose/master-key-generation.test.ts
delivers: the-instance-is-mine
spec: ../spec/vaubaan-gateway-07-workflows.md#71-install-an-instance

### Move my missions from my computer to a team server

status: proposed
requires: instance, mission, account
delivers: moving-from-my-computer-to-the-team-server, bringing-my-team-later-without-starting-over
spec: ../spec/vaubaan-gateway-07-workflows.md#71-install-an-instance
acceptance:

- One export from the desktop app and one import on the server carry my missions, their versions and their history
- Accounts arrive disconnected and say which to reconnect; no service credential leaves my computer in the export
- Every mission token is reissued on the server, and no mission holds more than it held before the move

## Share accounts without handing over a token

### Give access to an account, permission by permission

status: implemented
requires: account
creates: share, restriction
anchors: apps/gateway/src/server/shares/service.ts, apps/gateway/tests/integration/authority/share-and-orphan.test.ts
delivers: each-hand-gives-less, nobody-holds-a-token
spec: ../spec/vaubaan-gateway-07-workflows.md#73-give-access

### See every mission that carries my account

status: implemented
requires: account
anchors: apps/gateway/src/server/missions/mission-closing.ts, apps/gateway/tests/integration/authority/missions-on-account.test.ts
relieves: a-mission-on-production-i-know-nothing-about
delivers: every-mission-on-my-account-named
spec: ../spec/vaubaan-gateway-02-domain.md#22-definitions

## Welcome my teammates

### Welcome an invited teammate

status: proposed
requires: invitation
relieves: teammates-who-land-on-a-mute-page, i-don-t-know-what-this-is
spec: ../spec/vaubaan-gateway-04-surfaces.md#42-human-surface
acceptance:

- The sign-in page reached from an invitation says what Vaubaan is and who invited me
- My first "Now" page explains in two sentences what I can do, with a link to the site

### Generate my own key on a mission I was given

status: implemented
requires: mission, mission-member
creates: mission-token
anchors: apps/gateway/src/server/missions/member-token.ts, apps/gateway/src/server/missions/team-service.ts, apps/gateway/tests/integration/missions/team.test.ts
relieves: asking-someone-for-a-token
delivers: my-key-in-one-click, every-call-under-my-own-name, nothing-to-configure
spec: ../spec/vaubaan-gateway-07-workflows.md#79-bis-work-on-a-mission-as-a-team

### Name a stand-in who answers when I'm away

status: proposed
requires: mission, request
relieves: stuck-when-the-creator-is-away
spec: ../spec/vaubaan-gateway-03-authority.md#34-requests-to-the-creator--the-claim
acceptance:

- The owner has settled whether anyone but the creator may answer (open question in spec §11.2), and §3.4 says who
- A mission's creator names a stand-in among the mission members, and the mission page shows who it is
- A request reaches the stand-in when the creator is marked away, and the audit says who answered

## Keep the team's record

### Export the activity

status: proposed
requires: audit
relieves: the-record-cannot-leave
spec: ../spec/vaubaan-gateway-08-audit.md#8-audit
acceptance:

- An administrator downloads the activity of a period as CSV and JSON, from the Activity page
- The export holds the events the page shows, and never a credential or a call's content

### Stop whoever leaves the company's directory

status: proposed
requires: user, sign-in-provider-idp
relieves: someone-who-left-stays-active
spec: ../spec/vaubaan-gateway-02-domain.md#23-states
acceptance:

- A user the sign-in provider no longer admits can neither sign in nor call with their keys, without an administrator acting
- Their missions show on the administrator's page as without an owner, with the reason and the date
- The audit records the deactivation and the sign-in provider that caused it
