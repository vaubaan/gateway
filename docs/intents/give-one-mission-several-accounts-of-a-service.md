---
title: Give one mission several accounts of a service
status: proposed
actors: [user, agent]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-22
---

# Give one mission several accounts of a service

As a person who creates a mission, I want it to carry several accounts of one service (two
GitHub repositories, each with its own token) so that one agent works across them in one mission
while each key still reaches one resource.

## Put two accounts of one service in a mission

status: proposed
requires: mission, account, service
spec: ../spec/vaubaan-gateway.md#31-the-chain
acceptance:

- Creating or editing a mission with two accounts of one service succeeds; the mission page shows each account with its own resources, permissions and budget
- Each account is still checked against the creator's authority on it; an account outside it is refused by name

## Let my agent call the right account by the resource it names

status: proposed
requires: mission, account, resource
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- `tools/list` shows a service's tools once, whatever the number of its accounts in the mission
- A call naming a resource runs with the account that holds it, is judged and charged in that account's set, and its audit entry names that account
- A call naming a resource no account of the mission holds is refused `resource-not-in-mission`, listing the resources of every account of that service
- A call that names no resource, or resources of two accounts, while two accounts of its service could serve it is refused `account-ambiguous`, naming the candidate accounts with their resources and telling the agent to name the resource; a tool that can name no resource is refused so too
- The git remote exposes each account's repository at its own URL (`/git/github/<owner>/<repo>.git`), both reachable with the same mission token; the URL names the repository, so it never needs disambiguating

## Let a tool that names no resource answer every account

status: proposed
requires: mission, account, resource
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- A tool that names no resource, in a mission with two accounts of its service, runs on each account and answers one merged result
- Each account's run is judged and charged in that account's set and audited apart; one account waiting for an approval leaves the result marked partial
