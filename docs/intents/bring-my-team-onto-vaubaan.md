---
title: Bring my team onto Vaubaan
status: proposed
actors: [user, administrator]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-20
---

# Bring my team onto Vaubaan

As a person who started alone, I want to move my work to a server my team shares and welcome my
teammates there, so that adopting Vaubaan as a team never means starting over.

## Move my missions from my computer to a team server

status: proposed
requires: instance, mission, account
spec: ../spec/vaubaan-gateway.md#71-install-an-instance
acceptance:

- One export from the desktop app and one import on the server carry my missions, their versions and their history
- Accounts arrive disconnected and say which to reconnect; no service credential leaves my computer in the export
- Every mission token is reissued on the server, and no mission holds more than it held before the move

## Welcome an invited teammate

status: proposed
requires: invitation
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- The sign-in page reached from an invitation says what Vaubaan is and who invited me
- My first "Now" page explains in two sentences what I can do, with a link to the site

## Name a stand-in who answers when I'm away

status: proposed
requires: mission, request
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- A mission's creator names a stand-in among the mission members, and the mission page shows who it is
- A request reaches the stand-in when the creator is marked away, and the audit says who answered

## Export the activity

status: proposed
requires: audit
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- An administrator downloads the activity of a period as CSV and JSON, from the Activity page
- The export holds the events the page shows, and never a credential or a call's content
