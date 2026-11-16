---
title: GitHub Projects is a plugin of its own, next to the GitHub plugin, and copies its token handling
status: accepted
date: 2026-11-16
author: drafted with Claude
---

# GitHub Projects is a plugin of its own, next to the GitHub plugin, and copies its token handling

## Context

Agents need to read and update an organization's GitHub Projects (v2) boards. The GitHub plugin
models one repository per account ([token first](one-place-to-authorize-services-token-first.md),
amendment 2026-11-16), and every slice of its data model is rooted at `repo`. A project belongs
to an organization, not to a repository: its items come from many repositories, and its
fine-grained token permission ("Projects") is an organization permission. A plugin imports
`@vaubaan/plugin-sdk` and nothing else, so two plugins cannot share code without a new package.

## Decision

GitHub Projects is the service `github-projects` (`plugins/github-projects`): its own account
(a fine-grained token over one organization's project), data model rooted at `project`, risk
catalog and macro-actions. Its token handling (fine-grained pattern, expiry header, `verify`,
guide) is a copy of the GitHub plugin's, adapted, with a comment naming the original; no package
is shared between the two plugins.

## Consequences

- A Projects tool is never added to the GitHub plugin, and a repository tool never to this one:
  each keeps one root entity and one kind of resource.
- A change to how GitHub tokens are checked (pattern, expiry, API version) is made in both
  plugins, in the same pull request.
- A mission that both changes code and moves its card on the board holds two accounts and
  accepts risks of both services.

## Rejected alternatives

### Projects tools inside the GitHub plugin

One account and one token for both, but a second root entity next to `repo`, a resource that is
not a repository on a one-repository account, and an organization permission on a token
guided as one repository's.

### A package shared by both plugins

Avoids the copy, but needs an exception to the plugin import rule (ADR
[plugin-contract-and-credential-spec](plugin-contract-and-credential-spec.md)) for a few dozen
lines that change rarely.
