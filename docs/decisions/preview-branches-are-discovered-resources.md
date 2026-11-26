---
title: A project's preview branch is a resource of its own, discovered and labelled by the plugin, and a tool that reveals new resources triggers the account's discovery
status: accepted
date: 2026-11-26
author: Renaud Pelissier (product owner), drafted with Claude
---

# A project's preview branch is a resource of its own, discovered and labelled by the plugin, and a tool that reveals new resources triggers the account's discovery

## Context

A service that opens a copy of a project per pull request (Supabase Preview Branches) gives each
copy its own ref, unlisted among the account's projects and replaced when the branch is recreated.
A mission judges a call by the resource set of the resource it cites, one environment per set
(risk model §4.7), so a branch must be judged as `preview` whatever its parent project's label.

## Decision

The plugin's discovery lists each preview branch as a resource of its own, labelled by the plugin
with the environment `preview` and carrying its parent's ref in its metadata. A plugin may declare
`resourceRevealingTools`: after one succeeds, the host runs the account's discovery off the request
path, as after a creating tool, without adding anything to the mission by itself.

## Consequences

- A branch reaches a mission like any resource: listed, or taken by a `preview` set with future
  resources on. A recreated branch is a new resource; the replaced ref goes stale.
- A plugin never resolves a branch through its parent at call time: the ref the call names is the
  resource the call is judged on.
- A tool that only lists is declared revealing, never creating: only a creating tool's answer adds
  resources to the mission that made the call.

## Rejected alternatives

### Reach a branch through its parent project

Resolving the branch from the mission's parent project at call time puts the call in the parent's
set, judged with the staging or prod policy. Judging it as `preview` would mean placing calls by
environment rather than by resource, a change to the core of the risk model.

### Rediscover the account when a call names an unknown ref

The host cannot tell an unknown ref from a malformed argument, so every refused call would cost
the service a discovery.

### Declare the listing tool as a creating tool

A creating call adds what it returns to its own set: branches would join the parent's set, in
another environment.
